'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = name => (...args) => ipcRenderer.invoke(name, ...args);
contextBridge.exposeInMainWorld('bridge', Object.freeze({
  getState: invoke('get-state'), list: invoke('list'), login: invoke('login'), saveCredentials: invoke('save-credentials'), logout: invoke('logout'),
  chooseCache: invoke('choose-cache'), clearCache: invoke('clear-cache'), resetApp: invoke('reset-app'), startTransfer: invoke('start-transfer'), pauseQueue: invoke('pause-queue'),
  resumeQueue: invoke('resume-queue'), cancelJob: invoke('cancel-job'), retryJob: invoke('retry-job'), openFolder: invoke('open-folder'),
  onState: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('state', listener); return () => ipcRenderer.removeListener('state', listener); }
}));
