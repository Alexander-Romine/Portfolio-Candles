'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // portfolios & positions
  getPortfolios: () => ipcRenderer.invoke('portfolios:get'),
  createPortfolio: (name) => ipcRenderer.invoke('portfolios:create', name),
  renamePortfolio: (id, name) => ipcRenderer.invoke('portfolios:rename', { id, name }),
  deletePortfolio: (id) => ipcRenderer.invoke('portfolios:delete', id),
  setActivePortfolio: (id) => ipcRenderer.invoke('portfolios:setActive', id),
  savePosition: (pos) => ipcRenderer.invoke('portfolio:save', pos),
  deletePosition: (symbol) => ipcRenderer.invoke('portfolio:delete', symbol),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  testConnection: (apiKey) => ipcRenderer.invoke('settings:test', apiKey),

  // market data
  getStatus: () => ipcRenderer.invoke('market:status'),
  getCandles: (symbol, timeframe) => ipcRenderer.invoke('candles:get', { symbol, timeframe }),
  getQuotes: (symbols) => ipcRenderer.invoke('quotes:get', symbols),
  getProfile: (symbol) => ipcRenderer.invoke('profile:get', symbol),
  watchSymbol: (symbol) => ipcRenderer.send('watch:symbol', symbol),

  // desktop widget
  getWidget: () => ipcRenderer.invoke('widget:get'),
  setWidget: (enabled) => ipcRenderer.invoke('widget:set', enabled),

  // fullscreen (main window only — the widget stays a background panel)
  toggleFullscreen: () => ipcRenderer.send('window:fullscreen-toggle'),
  setFullscreen: (enabled) => ipcRenderer.send('window:fullscreen-set', enabled),
  getWindowFullscreen: () => ipcRenderer.invoke('window:fullscreen-get'),

  // events from the main process
  onQuote: (callback) => {
    ipcRenderer.on('market:quote', (_event, quote) => callback(quote));
  },
  onStatus: (callback) => {
    ipcRenderer.on('market:status', (_event, status) => callback(status));
  },
  onPortfolioChanged: (callback) => {
    ipcRenderer.on('portfolio:changed', (_event, state) => callback(state));
  },
  onWidgetChanged: (callback) => {
    ipcRenderer.on('widget:changed', (_event, state) => callback(state));
  },
  onFullscreenChanged: (callback) => {
    ipcRenderer.on('window:fullscreen', (_event, state) => callback(state));
  },
  onOpenSymbol: (callback) => {
    ipcRenderer.on('app:open-symbol', (_event, symbol) => callback(symbol));
  }
});
