const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  fetchResource: (url) => ipcRenderer.invoke('fetch-resource', url),
  downloadFiles: (opts) => ipcRenderer.invoke('download-files', opts),
  retryFailed: (opts) => ipcRenderer.invoke('retry-failed', opts),
  cancelDownload: () => ipcRenderer.invoke('cancel-download'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onProgress: (cb) => {
    ipcRenderer.on('download-progress', (_e, data) => cb(data));
  },
  getToken: () => ipcRenderer.invoke('get-token'),
  setToken: (token) => ipcRenderer.invoke('set-token', token),
  loadCatalog: () => ipcRenderer.invoke('catalog:load'),
  getCatalogTree: (defaultTag) => ipcRenderer.invoke('catalog:tree', defaultTag),
  searchCatalog: (query) => ipcRenderer.invoke('catalog:search', query),
  resolveCatalogBooks: (books) => ipcRenderer.invoke('catalog:books', books),
  onCatalogProgress: (cb) => {
    ipcRenderer.on('catalog-progress', (_e, data) => cb(data));
  },
});
