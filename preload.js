const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  send: (action, arg) => ipcRenderer.send('ui', action, arg),
  on: (channel, callback) => ipcRenderer.on(channel, (_, ...args) => callback(...args)),
});
