const { chromium } = require('C:/Users/admin1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const path = require('node:path');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: {width: 1586, height: 992}, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {if(m.type()==='error') errors.push(m.text());});
  await page.goto('file:///' + path.resolve(__dirname, '../src/index.html').replace(/\\/g,'/'));
  await page.waitForTimeout(300);
  fs.mkdirSync(path.resolve(__dirname, '../qa/browser'), {recursive: true});
  const results=[];
  for (const name of ['overview','robots','models','memory','system']) {
    await page.evaluate(name => window.demo.navigate(name), name);
    await page.waitForTimeout(200);
    await page.screenshot({path:path.resolve(__dirname, '../qa/browser', name+'.png')});
    results.push(await page.evaluate(name=>window.demo.inspect(name),name));
  }
  const interaction=await page.evaluate(()=>window.demo.selfTest());
  const providerChecks=[];
  await page.evaluate(()=>window.demo.navigate('models'));
  for(const provider of ['deepseek','doubao','openai','glm','ollama']){
    await page.locator(`[data-action="provider"][data-id="${provider}"]`).click();
    await page.waitForTimeout(100);
    providerChecks.push(await page.evaluate(id=>({provider:id,missingImages:window.demo.inspect('models').missingImages}),provider));
  }
  results.push(interaction,{providerChecks},{errors});
  fs.writeFileSync(path.resolve(__dirname,'../qa/browser/results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
  await browser.close();
  if(errors.length||!interaction.passed||providerChecks.some(p=>p.missingImages.length))process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1);});
