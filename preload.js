const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  send: (action, arg) => ipcRenderer.send('ui', action, arg),
  on: (channel, callback) => ipcRenderer.on(channel, (_, ...args) => callback(...args)),
});

// The <browser-action-list> element: toolbar buttons of Chrome extensions. Main window only:
// the suggestions page shares this preload and runs sandboxed, where only 'electron' can be required.
if (location.pathname.endsWith('/index.html')) require('electron-chrome-extensions/browser-action').injectBrowserAction();
