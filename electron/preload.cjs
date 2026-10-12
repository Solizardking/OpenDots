const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('solanaDots', Object.freeze({
  platform: process.platform,
  session: () => ipcRenderer.invoke('dots:session'),
  settings: () => ipcRenderer.invoke('dots:settings'),
  saveSettings: values => ipcRenderer.invoke('dots:save-settings', values),
  companion: (action, value) => ipcRenderer.invoke('dots:companion', action, value),
  keepAwake: enabled => ipcRenderer.invoke('dots:keep-awake', enabled),
  onAction: callback => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on('dots:action', handler);
    return () => ipcRenderer.removeListener('dots:action', handler);
  },
}));
