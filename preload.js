const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  fetchResource: (url) => ipcRenderer.invoke('fetch-resource', url),
  downloadFiles: (opts) => ipcRenderer.invoke('download-files', opts),
  cancelDownload: () => ipcRenderer.invoke('cancel-download'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onProgress: (cb) => {
    ipcRenderer.on('download-progress', (_e, data) => cb(data));
  },
  getToken: () => ipcRenderer.invoke('get-token'),
  setToken: (token) => ipcRenderer.invoke('set-token', token),
});
