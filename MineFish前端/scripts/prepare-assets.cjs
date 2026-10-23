const fs = require('node:fs');
const path = require('node:path');
const base = path.resolve(__dirname, '..');
for (const name of ['deepseek-color','doubao-color','openai','zhipu-color','ollama']) {
  fs.copyFileSync(path.join(base, 'node_modules/@lobehub/icons-static-svg/icons', name+'.svg'), path.join(base, 'assets', name+'.svg'));
}
fs.copyFileSync(path.join(base, 'node_modules/lucide/dist/umd/lucide.js'), path.join(base, 'assets/lucide.js'));
console.log('Offline icons ready.');
