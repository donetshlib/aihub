const { contextBridge, ipcRenderer } = require('electron');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');

contextBridge.exposeInMainWorld('hub', {
  send: (action, arg) => ipcRenderer.send('ui', action, arg),
  on: (channel, callback) => ipcRenderer.on(channel, (_, ...args) => callback(...args)),
});

// The <browser-action-list> element: toolbar buttons of Chrome extensions.
injectBrowserAction();
