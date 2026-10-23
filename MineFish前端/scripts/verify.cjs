const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const results=JSON.parse(fs.readFileSync(path.join(root,'qa/portable/results.json'),'utf8'));
const pages=results.filter(r=>r.page);
for(const p of pages){
  if(p.missingImages.length||p.overflow.length||p.scrollHeight>p.contentHeight+2)throw Error('Page validation failed: '+p.page);
}
const tests=results.find(r=>r.type==='interaction-tests');
if(!tests?.passed)throw Error('Interaction test failed');
const exe=path.join(root,'MineFish-Demo.exe');
if(!fs.existsSync(exe))throw Error('Portable EXE is missing');
const pe=fs.openSync(exe,'r'),header=Buffer.alloc(2);fs.readSync(pe,header,0,2,0);fs.closeSync(pe);
if(header.toString()!=='MZ')throw Error('Invalid Windows EXE');
console.log(`${pages.length} pages checked; ${tests.checks.length} interactions passed; Windows portable EXE ${(fs.statSync(exe).size/1024/1024).toFixed(1)} MiB.`);
