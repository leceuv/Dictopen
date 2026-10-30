'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const handler = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('dictee', {
  // réglages & clé
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),
  getDefaults: () => ipcRenderer.invoke('settings:defaults'),
  setMode: (mode) => ipcRenderer.invoke('mode:set', mode),
  toggleMode: () => ipcRenderer.invoke('mode:toggle'),
  getApiKeyMasked: (provider) => ipcRenderer.invoke('apikey:masked', provider),
  setApiKey: (key, provider) => ipcRenderer.invoke('apikey:set', key, provider),
  testApiKey: (provider) => ipcRenderer.invoke('apikey:test', provider),
  readClipboardText: () => ipcRenderer.invoke('clipboard:readText'),
  // consommation
  getUsage: () => ipcRenderer.invoke('usage:get'),
  resetUsage: () => ipcRenderer.invoke('usage:reset'),
  onUsage: (cb) => on('usage', cb),
  // dictée
  startRecording: () => ipcRenderer.invoke('rec:start'),
  stopRecording: () => ipcRenderer.invoke('rec:stop'),
  toggleRecording: () => ipcRenderer.invoke('rec:toggle'),
  cancelRecording: () => ipcRenderer.invoke('rec:cancel'),
  rediger: () => ipcRenderer.invoke('draft:rediger'),
  newDraft: () => ipcRenderer.invoke('draft:new'),
  getDraft: () => ipcRenderer.invoke('draft:get'),
  copyLastText: () => ipcRenderer.invoke('text:copyLast'),
  correctSelection: () => ipcRenderer.invoke('text:correctSelection'),
  // fenêtre de relecture d'une correction
  onReviewData: (cb) => on('review:data', cb),
  reviewReplace: (text) => ipcRenderer.invoke('review:replace', text),
  reviewCopy: (text) => ipcRenderer.invoke('review:copy', text),
  reviewClose: () => ipcRenderer.invoke('review:close'),
  onState: (cb) => on('state', cb),
  onLiveText: (cb) => on('liveText', cb),
  onDraft: (cb) => on('draft', cb),
  onNotice: (cb) => on('notice', cb),
  onPanel: (cb) => on('panel', cb),
  setPanel: (show) => ipcRenderer.invoke('panel:set', show),
  onLevel: (cb) => on('level', cb),
  // audio (le rendu capte, le principal envoie)
  onCaptureCommand: (cb) => on('capture', cb),
  sendAudioChunk: (buf) => ipcRenderer.send('audio:chunk', buf),
  sendAudioLevel: (level) => ipcRenderer.send('audio:level', level),
  reportCaptureError: (msg) => ipcRenderer.send('audio:error', msg),
  sendAudioDevice: (label) => ipcRenderer.send('audio:device', label),
  // SpeechMike (WebHID dans le rendu)
  sendMicButton: (ev) => ipcRenderer.send('mic:button', ev),
  sendMicStatus: (st) => ipcRenderer.send('mic:status', st),
  onHidOutput: (cb) => on('hid:output', cb),
  logInfo: (msg) => ipcRenderer.send('log:info', msg),
  onMicStatus: (cb) => on('micStatus', cb),
  requestPairMicrophone: () => ipcRenderer.invoke('mic:pairRequest'),
  onPairMicrophone: (cb) => on('mic:pair', cb),
  // autorisations (macOS)
  platform: process.platform,
  checkPermissions: () => ipcRenderer.invoke('perms:check'),
  requestPermissions: () => ipcRenderer.invoke('perms:request'),
  closePermissionsWindow: () => ipcRenderer.invoke('perms:close'),
  openPrivacyPane: (pane) => ipcRenderer.invoke('perms:openPane', pane),
  // fenêtres
  openSettings: () => ipcRenderer.invoke('win:settings'),
  hideBar: () => ipcRenderer.invoke('win:hideBar'),
  quit: () => ipcRenderer.invoke('app:quit'),
  installExtension: () => ipcRenderer.invoke('extension:install'),
});
