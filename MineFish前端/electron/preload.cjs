const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  windowControl: action => { if (['minimize', 'maximize', 'close'].includes(action)) ipcRenderer.send('window-control', action); }
});
