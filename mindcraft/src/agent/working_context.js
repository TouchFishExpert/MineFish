export const WORK_CONTEXT_ROUNDS = 10;

// Old saves have no round identifiers. Recover input/reply/result groups once,
// without mutating the original data or treating a tool result as a new round.
export function tagLegacyRounds(turns) {
    let current = null, answered = false;
    return turns.map((turn, index) => {
        if (turn.roundId) {if (current !== turn.roundId) answered = false; current = turn.roundId; answered ||= turn.role === 'assistant'; return {...turn};}
        if (!current || turn.role === 'user' || (turn.role === 'assistant' && answered)) {
            current = `legacy-${index}`; answered = false;
        }
        if (turn.role === 'assistant') answered = true;
        return {...turn, roundId: current};
    });
}

export function selectWorkingContext(input, {roundLimit = WORK_CONTEXT_ROUNDS, currentRoundId = null} = {}) {
    const turns = tagLegacyRounds(input || []), groups = new Map();
    for (let index = 0; index < turns.length; index++) {
        const turn = turns[index];
        const group = groups.get(turn.roundId) || {id: turn.roundId, answered: false, last: index};
        group.answered ||= turn.role === 'assistant'; group.last = index;
        groups.set(group.id, group);
        if (turn.currentRound) currentRoundId = turn.roundId;
    }
    const ordered = [...groups.values()].sort((a, b) => a.last - b.last);
    const answered = ordered.filter(group => group.answered);
    const keep = new Set(answered.slice(-roundLimit).map(group => group.id));
    const pending = ordered.filter(group => !group.answered);
    // One current input in addition to ten replied rounds. Before the first
    // response, retain at most ten inputs, so an input-only burst is bounded too.
    if (!currentRoundId) for (const group of (answered.length ? pending.slice(-1) : pending.slice(-roundLimit))) keep.add(group.id);
    if (currentRoundId) {
        const current = groups.get(currentRoundId);
        if (current?.answered && !keep.has(currentRoundId) && keep.size >= roundLimit) keep.delete(keep.values().next().value);
        keep.add(currentRoundId);
    }
    return turns.filter(turn => keep.has(turn.roundId));
}

export function workingRoundCount(turns) {
    return new Set(tagLegacyRounds(turns || []).filter(turn => turn.role === 'assistant').map(turn => turn.roundId)).size;
}
