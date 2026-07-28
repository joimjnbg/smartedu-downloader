const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  fetchResource: (url) => ipcRenderer.invoke('fetch-resource', url),
  downloadFiles: (opts) => ipcRenderer.invoke('download-files', opts),
  onProgress: (cb) => {
    ipcRenderer.on('download-progress', (_e, data) => cb(data));
  },
  getToken: () => ipcRenderer.invoke('get-token'),
  setToken: (token) => ipcRenderer.invoke('set-token', token),
});
