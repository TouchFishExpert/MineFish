import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {History, SUMMARY_MAINTENANCE_INTERVAL_MS} from '../mindcraft/src/agent/history.js';
import {setSettings} from '../mindcraft/src/agent/settings.js';
import {Prompter} from '../mindcraft/src/models/prompter.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd(), temporary = fs.mkdtempSync(path.join(root, 'summary-cadence-'));
const originalNow = Date.now, histories = [], checks = [];
let now = originalNow(), calls = 0;
Date.now = () => now; process.chdir(temporary); setSettings({max_messages: 16});
const fixture = name => {
    const agent = {name, responseEpoch: 0, self_prompter: {state: 0, isStopped: () => true}, task: {},
        prompter: {promptMemSaving: async () => {calls++; return '归纳后的事实';}}};
    const history = new History(agent); agent.history = history; histories.push(history); return agent;
};
try {
    assert.equal(SUMMARY_MAINTENANCE_INTERVAL_MS, 60000);
    const a = fixture('Cadence');
    for (let n = 0; n < 150; n++) await a.history.add('GGboy', `待处理事实${n}`, {maintainSummary: false});
    await a.history.maintainSummary();
    assert.equal(calls, 1); assert.equal(a.history.summaryPending, 100);
    const cursor = a.history.summaryCursor;
    for (let n = 0; n < 20; n++) await a.history.maintainSummary();
    assert.equal(calls, 1); assert.equal(a.history.summaryCursor, cursor);
    const saved = JSON.parse(fs.readFileSync(a.history.memory_fp));
    assert.ok(saved.working_context.nextSummaryRunAt > now);
    const reloaded = new History(a); histories.push(reloaded); reloaded.load();
    await reloaded.maintainSummary(); assert.equal(calls, 1, 'Restart preserves the cooldown');
    now += 60001;
    await a.history.maintainSummary(); assert.equal(calls, 2); assert.equal(a.history.summaryPending, 50);
    assert.equal(fs.readFileSync(a.history.journal.file, 'utf8').trim().split('\n').length, 150);
    checks.push('150-message backlog processes one bounded batch per pass; repeated triggers and restart respect persisted 60s spacing; no journal records discarded');

    const b = fixture('Length'); b.history.memory = '原'.repeat(2450);
    const input = [];
    b.prompter.promptSummaryCompression = async text => {input.push(text); return input.length === 1 ? '中'.repeat(2200) : '短'.repeat(1800);};
    await b.history.compactSummaryIfNeeded();
    assert.equal(input.length, 2); assert.equal(input[1].length, 2200);
    assert.equal(b.history.memory.length, 1800);
    checks.push('Compression enforces 2000-character target; retry refines the previous candidate instead of resubmitting the original');

    const c = fixture('Backoff'); c.history.memory = '原'.repeat(2450); let failedCalls = 0;
    c.prompter.promptSummaryCompression = async () => {failedCalls++; return '长'.repeat(2450);};
    await c.history.compactSummaryIfNeeded();
    assert.equal(failedCalls, 2); assert.equal(c.history.nextSummaryRetryAt - now, 60000);
    await c.history.compactSummaryIfNeeded(); assert.equal(failedCalls, 2);
    now += 60001; await c.history.compactSummaryIfNeeded();
    assert.equal(failedCalls, 4); assert.equal(c.history.nextSummaryRetryAt - now, 120000);
    assert.equal(c.history.memory.length, 2450);
    checks.push('Repeated failures back off from 60s to 120s; original memory and pending data retained');

    const prompter = Object.assign(Object.create(Prompter.prototype), {chat_model: {}, checkCooldown: async () => {}, _saveLog: async () => {}});
    const facts = Array.from({length: 30}, (_, n) => `事实${n + 1}：${'完整内容'.repeat(20)}。`);
    prompter.requestModel = async () => JSON.stringify({keep: Array.from({length: 30}, (_, n) => n + 1)});
    const selected = await prompter.promptSummaryCompression(facts.join('\n'));
    assert.ok(selected.length <= 2000); assert.equal(selected.split('\n').length, 16);
    assert.ok(selected.split('\n').every(fact => facts.includes(fact)));
    prompter.requestModel = async () => '{"keep":[999]}';
    await assert.rejects(prompter.promptSummaryCompression(facts.join('\n')), /Invalid fact selection/);
    prompter.requestModel = async () => '{"keep":[1]}';
    await assert.rejects(prompter.promptSummaryCompression('无法切断的长事实'.repeat(500)), /No complete selected fact/);
    checks.push('Model ranks complete source facts; code enforces fact count and character budget even if model exceeds requested count; no invented indices or character slicing');
    const report = {at: new Date().toISOString(), passed: true, checks};
    fs.writeFileSync(new URL('./summary-cadence-test-result.json', import.meta.url), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
} finally {
    for (const history of histories) clearTimeout(history.summaryTimer);
    Date.now = originalNow; process.chdir(cwd);
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(root)); fs.rmSync(temporary, {recursive: true, force: true});
}
