'use strict';

/* Preload for the desktop widget window — a read-only, compact view. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('portfolios:get'),
  getQuotes: (symbols) => ipcRenderer.invoke('quotes:get', symbols),
  open: (symbol) => ipcRenderer.send('widget:open', symbol),
  close: () => ipcRenderer.send('widget:close'),
  setHeight: (height) => ipcRenderer.send('widget:height', height),
  onQuote: (callback) => {
    ipcRenderer.on('market:quote', (_event, quote) => callback(quote));
  },
  onPortfolioChanged: (callback) => {
    ipcRenderer.on('portfolio:changed', (_event, state) => callback(state));
  }
});
