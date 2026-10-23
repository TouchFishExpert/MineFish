const { app, BrowserWindow, ipcMain, screen, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

if (process.env.MINEFISH_QA_DIR) app.setPath('userData', path.join(process.env.MINEFISH_QA_DIR, 'profile'));
app.setAppUserModelId('com.minefish.frontend.demo');
let win;
app.whenReady().then(() => {
  // This demo is entirely offline. No API, socket, external navigation or game connection.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_, cb) => cb({ cancel: true }));
  const area = screen.getPrimaryDisplay().workAreaSize;
  const factor = Math.min(1, (area.width - 70) / 1586, (area.height - 50) / 992);
  win = new BrowserWindow({
    width: Math.round(1586 * factor), height: Math.round(992 * factor),
    minWidth: 960, minHeight: 600, frame: false, show: false,
    title: 'MineFish · Minecraft AI Teammate', backgroundColor: '#eef7ff',
    icon: path.join(__dirname, '../assets/app.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('file://')) event.preventDefault(); });
  ipcMain.on('window-control', (event, action) => {
    if (event.sender !== win.webContents) return;
    if (action === 'minimize') win.minimize();
    if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    if (action === 'close') win.close();
  });
  win.loadFile(path.join(__dirname, '../src/index.html'));
  win.once('ready-to-show', () => win.show());
  if (process.env.MINEFISH_QA_DIR) {
    win.webContents.once('did-finish-load', async () => {
      const output = process.env.MINEFISH_QA_DIR;
      fs.mkdirSync(output, { recursive: true });
      await new Promise(r => setTimeout(r, 900));
      win.setContentSize(1586, 992);
      const results = [];
      for (const page of ['overview', 'robots', 'models', 'memory', 'system']) {
        await win.webContents.executeJavaScript(`window.demo.navigate('${page}')`);
        await new Promise(r => setTimeout(r, 220));
        fs.writeFileSync(path.join(output, page + '.png'), (await win.webContents.capturePage()).toPNG());
        results.push(await win.webContents.executeJavaScript(`window.demo.inspect('${page}')`));
      }
      results.push(await win.webContents.executeJavaScript('window.demo.selfTest()'));
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
      app.quit();
    });
  }
});
app.on('window-all-closed', () => app.quit());
