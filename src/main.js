'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, dialog, shell, systemPreferences, clipboard, screen, nativeTheme } = require('electron');
const { Store } = require('./store');
const { RealtimeTranscriber } = require('./realtime');
const { writeLetter, correctText, findClaudeCode } = require('./redaction');
const { LocalApi } = require('./local-api');
const { applyLocalPunctuation } = require('./punctuation');
const { pasteIntoActiveApp, pressHotkey, copySelectionNow, withTargetApp } = require('./inject');
const { audioCost, textCost } = require('./pricing');
const { correctTranscript } = require('./corrections');
const { wavFromPcm16 } = require('./wav');

app.setName('Dictopen');

// une seule instance : une seconde ouverture ramène la barre au premier plan
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (barWin) { barWin.showInactive(); } else { createBar(); } });
}

let store;
let barWin = null;
let settingsWin = null;
let reviewWin = null;
let tray = null;
const rt = new RealtimeTranscriber();

// --- état ---
let state = 'idle'; // idle | connecting | listening | transcribing | writing | correcting | error
let recording = false;
let audioBytes = 0; // octets PCM16 24 kHz envoyés pour l'énoncé en cours (48 000 o/s)
let peakLevel = 0; // niveau crête observé pendant l'énoncé (0..1) : détection de silence
let lastInjected = '';
let lastText = '';
let draft = ''; // mode courrier : dictée accumulée (brute)
let lastLetter = ''; // mode courrier : dernier courrier rédigé (pour les corrections)
let micStatus = { connected: false, name: '' };
let panelShown = false; // zone de texte de la barre (masquée par défaut : barre fine)
let pcmChunks = []; // audio de l'énoncé en cours, conservé seulement en transcription locale
let audioDevice = '';
let rightsDialogShown = false;

const BYTES_PER_SECOND = 24000 * 2;
const SILENCE_PEAK = 0.04; // en dessous : pas de parole (bruit de fond)

// Diagnostic : conserve l'énoncé (WAV 24 kHz + JSON) dans <données>/dictations/AAAA-MM-JJ/ — jamais synchronisé
let lastSample = null;
function saveDictationSample({ pcm, seconds, provider, model, transcript }) {
  try {
    const fs = require('fs');
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const dir = path.join(app.getPath('userData'), 'dictations', day);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = now.toTimeString().slice(0, 8).replace(/:/g, '') + '-' + String(now.getMilliseconds()).padStart(3, '0');
    const base = path.join(dir, stamp);
    if (pcm && pcm.length) fs.writeFileSync(base + '.wav', wavFromPcm16(pcm, 24000));
    lastSample = { base, meta: { time: now.toISOString(), seconds: Number(seconds.toFixed(2)), peak: Number(peakLevel.toFixed(3)), provider, model, mode: store.settings.mode, audioDevice, prompt: store.settings.transcription.prompt, keywordsCount: (store.settings.transcription.keywords || []).length, transcriptRaw: transcript } };
    fs.writeFileSync(base + '.json', JSON.stringify(lastSample.meta, null, 2));
  } catch (e) {
    console.warn('diagnostic : enregistrement impossible', e.message);
  }
}

// Diagnostic : version corrigée de référence = texte copié dans le presse-papiers qui ressemble aux énoncés récents
// (le courrier relu/corrigé par le praticien avant collage dans le dossier). Stocké dans dictations/<jour>/corrections/.
const recentTexts = []; // { time, text, base }
let clipboardWatch = null;
let lastClipboard = '';
function rememberDictated(text, base) {
  recentTexts.push({ time: Date.now(), text, base });
  while (recentTexts.length > 200) recentTexts.shift();
}
function wordSet(s) {
  return new Set((s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3));
}
async function checkClipboardForCorrection() {
  try {
    const text = (await clipboard.readText()) || '';
    if (text === lastClipboard) return;
    lastClipboard = text;
    if (text.length < 150) return;
    const since = Date.now() - 6 * 3600 * 1000;
    const candidates = recentTexts.filter((r) => r.time > since);
    if (!candidates.length) return;
    const clipWords = wordSet(text);
    const matched = [];
    let common = 0;
    for (const r of candidates) {
      const ws = wordSet(r.text);
      let c = 0;
      for (const w of ws) if (clipWords.has(w)) c++;
      if (ws.size && c / ws.size >= 0.5) { matched.push(path.basename(r.base)); common += c; }
    }
    if (!matched.length || common / Math.max(1, clipWords.size) < 0.4) return;
    const fs = require('fs');
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(app.getPath('userData'), 'dictations', day, 'corrections');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify({ time: new Date().toISOString(), text, matchedUtterances: matched }, null, 2));
    console.log(`diagnostic : version corrigée capturée (${text.length} caractères, ${matched.length} énoncés reliés)`);
  } catch (e) {
    console.warn('diagnostic presse-papiers', e.message);
  }
}
function updateClipboardWatch() {
  const on = !!store.settings.recordDictations;
  if (on && !clipboardWatch) clipboardWatch = setInterval(checkClipboardForCorrection, 2500);
  if (!on && clipboardWatch) { clearInterval(clipboardWatch); clipboardWatch = null; }
}

function completeDictationSample(finalText) {
  if (!lastSample) return;
  try {
    const fs = require('fs');
    lastSample.meta.transcriptFinal = finalText;
    fs.writeFileSync(lastSample.base + '.json', JSON.stringify(lastSample.meta, null, 2));
    rememberDictated(finalText, lastSample.base);
  } catch {}
  lastSample = null;
}

// Hallucinations typiques de whisper sur du bruit ou du silence.
const WHISPER_HALLUCINATIONS = [/sous-titres? (réalisés?|par)/i, /amara\.org/i, /merci d'avoir regardé/i, /abonnez-vous/i, /^\s*\[[^\]]*\]\s*$/, /^\s*\([^)]*\)\s*$/, /^\s*\.+\s*$/];
function looksLikeHallucination(text) {
  return WHISPER_HALLUCINATIONS.some((re) => re.test(text));
}

// Les modèles de transcription recrachent parfois le texte du contexte quand l'audio ne contient pas de parole.
function looksLikePromptEcho(transcript, prompt) {
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const t = norm(transcript);
  const p = new Set(norm(prompt));
  if (t.length < 6 || p.size === 0) return false;
  const inPrompt = t.filter((w) => p.has(w)).length / t.length;
  return inPrompt >= 0.85;
}

function send(channel, payload) {
  for (const w of [barWin, settingsWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function setState(s, detail) {
  state = s;
  send('state', { state: s, detail: detail || '', recording, mode: store.settings.mode, provider: store.currentProvider(), hasDraft: !!draft, hasLetter: !!lastLetter, mic: micStatus, audioDevice, hotkey: store.settings.hotkeyLabels.toggleRecording || store.settings.hotkeys.toggleRecording || '' });
}

function notice(level, message) {
  console[level === 'error' ? 'error' : 'log'](message);
  send('notice', { level, message });
}

function sendDraft() {
  send('draft', { text: draft, letter: lastLetter });
}

// --- fenêtres ---
// diagnostic des fenêtres : erreurs de chargement, plantages du rendu, console (niveaux warn/error)
function watchWindow(win, label) {
  const wc = win.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) => console.error(`${label} : échec de chargement ${code} ${desc} ${url}`));
  wc.on('render-process-gone', (_e, details) => console.error(`${label} : rendu interrompu`, details));
  wc.on('console-message', (ev) => {
    const level = typeof ev === 'object' && ev.level ? ev.level : 'info';
    const message = typeof ev === 'object' && ev.message !== undefined ? ev.message : String(ev);
    if (level === 'error' || level === 'warning') console.log(`${label} console[${level}] : ${message} (${ev.sourceId || ''}:${ev.lineNumber || ''})`);
  });
  wc.on('preload-error', (_e, p, err) => console.error(`${label} : erreur preload ${p}`, err.message));
}

function createBar() {
  const { x, y } = store.settings.bar;
  const display = screen.getPrimaryDisplay().workArea;
  barWin = new BrowserWindow({
    width: barSize()[0],
    height: barSize()[1],
    x: Number.isFinite(x) ? x : display.x + display.width - 480,
    y: Number.isFinite(y) ? y : display.y + 20,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    focusable: false, // la fenêtre cible garde le focus : le texte se colle chez elle
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: '#1e1f24',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  barWin.setAlwaysOnTop(true, 'floating');
  barWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  watchWindow(barWin, 'barre');
  barWin.loadFile(path.join(__dirname, '..', 'renderer', 'bar.html'));
  barWin.on('moved', () => {
    const [bx, by] = barWin.getPosition();
    store.saveSettings({ bar: { x: bx, y: by } });
  });
  barWin.on('closed', () => { barWin = null; });
  barWin.webContents.on('did-finish-load', () => {
    barWin.webContents.send('panel', { show: panelShown });
    setState(state);
    sendDraft();
    send('usage', store.usage);
    if (store.settings.transcription.keepMicrophoneOpen) barWin.webContents.send('capture', { cmd: 'open', deviceId: store.settings.transcription.microphoneId });
  });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 780,
    height: 860,
    title: 'Réglages — Dictopen',
    backgroundColor: '#f4f4f6',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  watchWindow(settingsWin, 'réglages');
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// dimensions de la barre : fine ou avec la zone de texte ; plus large en mode Courrier (deux boutons de plus)
function barSize() {
  const win = process.platform === 'win32';
  const width = (store.settings.mode === 'courrier' ? 550 : 470) + (win ? 40 : 0);
  const height = panelShown ? (win ? 200 : 190) : (win ? 76 : 70);
  return [width, height];
}

function applyBarSize() {
  if (!barWin) return;
  const [w, h] = barSize();
  barWin.setSize(w, h);
}

function setPanel(show) {
  panelShown = !!show;
  if (!barWin) return;
  applyBarSize();
  barWin.webContents.send('panel', { show: panelShown });
}

function toggleBar() {
  if (!barWin) return createBar();
  if (barWin.isVisible()) barWin.hide(); else barWin.showInactive();
}

// menu d'application : sans lui, Cmd+C / Cmd+V ne fonctionnent pas dans les fenêtres Electron sur macOS
function createAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ label: 'Réglages…', accelerator: 'Cmd+,', click: openSettings }, { type: 'separator' }, { role: 'hide' }, { role: 'quit', label: 'Quitter' }] },
    { label: 'Édition', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut', label: 'Couper' }, { role: 'copy', label: 'Copier' }, { role: 'paste', label: 'Coller' }, { role: 'selectAll', label: 'Tout sélectionner' }] },
    { label: 'Fenêtre', submenu: [{ label: 'Afficher / masquer la barre', click: toggleBar }, { role: 'close' }] },
  ]));
}

// lancement à l'ouverture de session (macOS : élément de connexion ; Windows : clé Run)
function applyLaunchAtLogin() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!store.settings.launchAtLogin, openAsHidden: true });
  } catch (e) {
    console.warn('lancement à la session', e.message);
  }
}

function createTray() {
  const icon = nativeImage.createFromDataURL(TRAY_ICON).resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Dictopen');
  const refresh = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: barWin && barWin.isVisible() ? 'Masquer la barre' : 'Afficher la barre', click: toggleBar },
    { label: store.settings.mode === 'courrier' ? 'Mode : Courrier (→ Dictée directe)' : 'Mode : Dictée directe (→ Courrier)', click: toggleMode },
    { type: 'separator' },
    { label: `Consommation : ${store.usage.usd.toFixed(2)} $`, enabled: false },
    { label: 'Réglages…', click: openSettings },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]));
  refresh();
  tray.on('click', refresh);
  tray.refresh = refresh;
}

// icône de barre de menus : un micro, 36×36, noir (template)
const TRAY_ICON = 'data:image/svg+xml;base64,' + Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24"><path fill="${process.platform === 'darwin' ? '#000' : '#fff'}" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z"/></svg>`
).toString('base64');

// --- raccourcis globaux ---
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const h = store.settings.hotkeys;
  const reg = (acc, fn, label) => {
    if (!acc) return;
    try {
      if (!globalShortcut.register(acc, fn)) notice('warn', `Raccourci « ${acc} » (${label}) indisponible`);
    } catch (e) {
      notice('warn', `Raccourci « ${acc} » invalide : ${e.message}`);
    }
  };
  reg(h.toggleRecording, () => toggleRecording(), 'dictée');
  reg(h.toggleBar, toggleBar, 'barre');
  reg(h.toggleMode, toggleMode, 'mode');
  reg(h.rediger, () => rediger(), 'rédiger');
  reg(h.newDraft, newDraft, 'nouveau courrier');
  reg(h.copyLastText, copyLastText, 'copier');
  reg(h.correctSelection, () => correctSelection(), 'corriger la sélection');
}

function toggleMode() {
  setMode(store.settings.mode === 'courrier' ? 'direct' : 'courrier');
}

function setMode(mode) {
  if (mode !== 'direct' && mode !== 'courrier') return;
  if (recording) cancelRecording();
  store.saveSettings({ mode });
  rt.close(); // le modèle de transcription peut différer : la session sera rouverte
  applyBarSize();
  setState('idle');
  if (tray) tray.refresh();
  console.log(mode === 'courrier' ? 'Mode Courrier' : 'Mode Dictée directe');
}

function copyLastText() {
  const t = store.settings.mode === 'courrier' ? (lastLetter || draft) : lastText;
  if (t) { clipboard.writeText(t); notice('info', 'Texte copié'); }
}

function newDraft() {
  draft = '';
  lastLetter = '';
  lastInjected = '';
  sendDraft();
  setState(state === 'listening' ? state : 'idle', 'nouveau courrier');
}

// --- connexion OpenAI ---
async function ensureConnected() {
  if (rt.isOpen) return;
  const key = await store.getApiKey();
  if (!key) {
    openSettings();
    throw new Error('Aucune clé API OpenAI : saisissez-la dans les réglages');
  }
  setState('connecting');
  await rt.connect(key, { transcription: store.effectiveTranscription() });
}

rt.on('delta', ({ text }) => send('liveText', { text, final: false }));
rt.on('error', (err) => notice('error', `OpenAI : ${err.message}`));
rt.on('status', (s) => { if ((s === 'disconnected' || s === 'connected') && state === 'connecting' && !recording) setState('idle'); });

// LED d'enregistrement : rapport(s) de sortie définis dans settings.led { on: [{reportId,data}], off: [...] }
function setRecordLed(on) {
  const led = store.settings.led;
  if (!led || !barWin) return;
  for (const cmd of (on ? led.on : led.off) || []) barWin.webContents.send('hid:output', cmd);
}

// --- enregistrement ---
async function startRecording() {
  if (recording) return;
  try {
    await ensureConnected();
  } catch (e) {
    setState('error', e.message);
    notice('error', e.message);
    return;
  }
  setRecordLed(true);
  console.log('dictée : début');
  recording = true;
  audioBytes = 0;
  peakLevel = 0;
  pcmChunks = [];
  rt.clear();
  send('liveText', { text: '', final: false });
  if (barWin) barWin.webContents.send('capture', { cmd: 'start', deviceId: store.settings.transcription.microphoneId });
  setState('listening');
}

async function stopRecording() {
  if (!recording) return;
  recording = false;
  // laisse arriver les derniers paquets audio avant de clore l'énoncé
  await new Promise((r) => setTimeout(r, store.settings.transcription.stopDelayMs || 150));
  if (barWin) barWin.webContents.send('capture', { cmd: 'stop' });
  const seconds = audioBytes / BYTES_PER_SECOND;
  setRecordLed(false);
  console.log(`dictée : fin, ${seconds.toFixed(2)} s d'audio`);
  if (seconds < 0.25) {
    rt.clear();
    pcmChunks = [];
    setState('idle', 'trop court');
    return;
  }
  if (peakLevel < SILENCE_PEAK) {
    console.log(`dictée : silence (crête ${peakLevel.toFixed(3)}), rien envoyé`);
    rt.clear();
    pcmChunks = [];
    setState('idle', 'silence');
    return;
  }
  setState('transcribing');
  let transcript;
  try {
    ({ transcript } = await rt.commit());
    console.log(`transcription reçue : ${(transcript || '').length} caractères`);
  } catch (e) {
    setState('error', e.message);
    notice('error', e.message);
    return;
  }
  const model = store.effectiveTranscription().model;
  if (store.settings.recordDictations) saveDictationSample({ pcm: Buffer.concat(pcmChunks), seconds, provider: 'openai', model, transcript });
  pcmChunks = [];
  const usage = store.addUsage({ audioSeconds: seconds, utterances: 1, usd: audioCost(model, seconds) });
  send('usage', usage);
  if (tray) tray.refresh();
  await processTranscript(transcript);
}

async function toggleRecording() {
  if (recording) await stopRecording(); else await startRecording();
}

function cancelRecording() {
  setRecordLed(false);
  if (recording) {
    recording = false;
    if (barWin) barWin.webContents.send('capture', { cmd: 'stop' });
  }
  pcmChunks = [];
  rt.clear();
  send('liveText', { text: '', final: false });
  setState('idle', 'annulé');
}

// Le modèle glisse parfois des caractères d'un autre alphabet (« postopératoire » écrit avec des lettres devanagari) : on les retire.
function stripForeignScripts(s) {
  return s.replace(/[^\p{Script=Latin}\p{Script=Common}\p{Script=Greek}\s]/gu, '');
}

async function processTranscript(raw) {
  let text = stripForeignScripts((raw || '').trim()).replace(/\s{2,}/g, ' ').trim();
  if (!text) { setState('idle', 'rien entendu'); return; }
  if (looksLikePromptEcho(text, store.settings.transcription.prompt) || looksLikeHallucination(text)) {
    console.log('transcription ignorée : écho du contexte ou hallucination (pas de parole)');
    setState('idle', 'rien entendu');
    return;
  }

  text = correctTranscript(text, { rules: store.settings.transcription.corrections, keywords: store.settings.transcription.keywords, phoneticEnabled: store.settings.transcription.phoneticCorrections !== false });

  if (store.settings.mode === 'courrier') {
    completeDictationSample(text);
    draft = draft ? `${draft}\n${text}` : text;
    sendDraft();
    send('liveText', { text, final: true });
    setState('idle', 'ajouté au brouillon');
    return;
  }

  // mode dictée directe
  if (store.settings.direct.localPunctuation) text = applyLocalPunctuation(text);
  completeDictationSample(text);
  lastText = text;
  send('liveText', { text, final: true });
  await pasteText(text);
}

async function pasteText(text, { raw = false } = {}) {
  // Si une de nos fenêtres a le focus (réglages), on ne colle pas : on copie.
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    console.log('collage : sauté, une fenêtre de l’app a le focus');
    clipboard.writeText(text);
    setPanel(true);
    setState('idle', 'copié (fenêtre de réglages active)');
    return;
  }
  let toPaste = text;
  if (!raw && store.settings.mode === 'direct' && store.settings.injection.autoSpace && lastInjected && !/[\s\n]$/.test(lastInjected) && !/^[\s\n,.;:!?)»]/.test(text)) {
    toPaste = ' ' + text;
  }
  try {
    console.log(`collage : ${toPaste.length} caractères`);
    await pasteIntoActiveApp(toPaste, store.settings.injection);
    console.log('collage : réussi');
    lastInjected = toPaste;
    setState('idle');
  } catch (e) {
    console.error('collage : échec', e.message || e);
    clipboard.writeText(text);
    setPanel(true);
    setState('error', 'collage impossible, texte copié');
    showRightsDialog(e);
  }
}

// --- correction du texte sélectionné dans l'application active ---
// La sélection est copiée, relue par le modèle, puis proposée dans une fenêtre (différences, texte modifiable) ; « Remplacer » la colle à la place.
let correcting = false;
let reviewTrailing = ''; // blancs de fin de la sélection, conservés au remplacement
function openReviewWindow() {
  if (reviewWin && !reviewWin.isDestroyed()) { reviewWin.show(); reviewWin.focus(); return reviewWin; }
  reviewWin = new BrowserWindow({
    width: 640, height: 480, minWidth: 420, minHeight: 300,
    title: 'Correction — Dictopen',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f22' : '#ffffff',
    autoHideMenuBar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  watchWindow(reviewWin, 'correction');
  reviewWin.loadFile(path.join(__dirname, '..', 'renderer', 'review.html'));
  reviewWin.on('closed', () => { reviewWin = null; });
  return reviewWin;
}
function sendReview(data) {
  const win = openReviewWindow();
  const deliver = () => { if (win && !win.isDestroyed()) win.webContents.send('review:data', data); };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver); else deliver();
}
function closeReviewWindow() {
  if (reviewWin && !reviewWin.isDestroyed()) reviewWin.close();
  reviewWin = null;
  if (process.platform === 'darwin') app.hide(); // rend l'activation à l'application précédente (la barre n'est pas focalisable)
}

async function correctSelection() {
  if (correcting || writing) return;
  if (recording) await stopRecording();
  const keys = await correctionKeys();
  const prov = store.settings.correction.provider || 'openai';
  if ((prov === 'openai' && !keys.openai) || (prov === 'anthropic' && !keys.anthropic)) { openSettings(); notice('error', prov === 'anthropic' ? 'Aucune clé Anthropic' : 'Aucune clé API'); return; }
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && focused !== reviewWin) { notice('error', 'Sélectionnez le texte dans l’application cible'); return; }
  if (focused === reviewWin && reviewWin) closeReviewWindow();
  correcting = true;
  setState('correcting', 'lecture de la sélection');
  try {
    const cfg = store.settings.correction;
    // Dictopen s'efface si la barre l'a mis au premier plan ; navigateur devant → l'extension « Dictopen pour Chrome »
    // sélectionne et corrige dans la page ; sinon la sélection est copiée ici
    const original = await withTargetApp(async (front) => {
      if (cfg.localApi && BROWSERS.test(front)) {
        if (localApi.broadcast({ type: 'correct' })) { console.log('correction : navigateur au premier plan → ordre envoyé à l’extension'); return null; }
        if (cfg.browserShortcut) {
          console.log(`correction : navigateur au premier plan, extension non connectée → raccourci ${cfg.browserShortcut}`);
          await pressHotkey(cfg.browserShortcut);
          return null;
        }
      }
      return copySelectionNow();
    });
    if (original === null) { setState('idle'); return; }
    if (!original.trim()) { setState('idle'); notice('error', 'Sélectionnez d’abord le texte à corriger'); return; }
    console.log(`correction : ${original.length} caractères sélectionnés (${cfg.provider || 'openai'})`);
    reviewTrailing = (original.match(/[\s]*$/) || [''])[0];
    setState('correcting');
    sendReview({ original: '', corrected: '', pending: true });
    const t0 = Date.now();
    const r = await correctText(keys, cfg, original, { level: cfg.level });
    if (!r.text) throw new Error('Correction : réponse vide');
    const usage = store.addUsage({ corrections: 1, textInputTokens: r.inputTokens, textOutputTokens: r.outputTokens, usd: textCost(r.model, r.inputTokens, r.outputTokens) });
    send('usage', usage);
    if (tray) tray.refresh();
    const same = r.text === original.trimEnd();
    console.log(`correction : ${r.text.length} caractères, ${r.inputTokens}/${r.outputTokens} jetons, ${Date.now() - t0} ms${same ? ', aucune modification' : ''}`);
    lastText = r.text;
    setState('idle', same ? 'aucune correction nécessaire' : 'correction proposée');
    sendReview({ original: original.trimEnd(), corrected: r.text, ms: Date.now() - t0 });
  } catch (e) {
    console.error('correction : échec', e.message);
    setState('error', e.message);
    notice('error', e.message);
    if (reviewWin) sendReview({ error: e.message });
    showRightsDialog(e);
  } finally {
    correcting = false;
  }
}

const BROWSERS = /^(Google Chrome|Chromium|Brave Browser|Microsoft Edge|Arc|Vivaldi|Opera|firefox|Firefox|chrome|msedge|brave|opera|vivaldi)/i;
// API locale pour l'extension de navigateur : relecture d'un texte (ou de segments balisés) avec la clé enregistrée
const localApi = new LocalApi({
  version: app.getVersion(),
  log: (m) => console.log(m),
  onCorrect: async ({ text, level, segments, context }) => {
    const cfg = store.settings.correction;
    const keys = await correctionKeys();
    const t0 = Date.now();
    const r = await correctText(keys, cfg, text, { level, segments, context });
    const usage = store.addUsage({ corrections: 1, textInputTokens: r.inputTokens, textOutputTokens: r.outputTokens, usd: textCost(r.model, r.inputTokens, r.outputTokens) });
    send('usage', usage);
    if (tray) tray.refresh();
    console.log(`correction (extension, ${cfg.provider || 'openai'}/${r.model}, ${level}${segments ? ', segments' : ''}) : ${text.length} → ${r.text.length} caractères, ${r.inputTokens}/${r.outputTokens} jetons, ${Date.now() - t0} ms`);
    return { text: r.text, ms: Date.now() - t0 };
  },
});
async function correctionKeys() {
  return { openai: await store.getApiKey('openai'), anthropic: await store.getApiKey('anthropic') };
}

function applyLocalApi() {
  const cfg = store.settings.correction;
  if (cfg.localApi) localApi.start(Number(cfg.localApiPort) || 47395); else localApi.stop();
}

async function replaceWithReview(text) {
  closeReviewWindow();
  await new Promise((r) => setTimeout(r, 400)); // le temps que l'application cible redevienne active
  if (BrowserWindow.getFocusedWindow()) return { error: 'L’application cible n’a pas repris le focus : utilisez « Copier »' };
  try {
    await pasteIntoActiveApp(text + reviewTrailing, store.settings.injection);
    console.log(`correction : ${text.length} caractères remplacés`);
    setState('idle', 'texte remplacé');
    return { ok: true };
  } catch (e) {
    console.error('correction : remplacement échoué', e.message);
    clipboard.writeText(text);
    setState('error', 'remplacement impossible, texte copié');
    showRightsDialog(e);
    return { error: `Remplacement impossible (${e.message}) : texte copié, collez-le avec ⌘V` };
  }
}

// --- mode courrier : rédaction ---
let writing = false;
async function rediger() {
  if (store.settings.mode !== 'courrier') { notice('warn', 'Passez en mode Courrier pour rédiger'); return; }
  if (writing) return;
  if (recording) await stopRecording();
  if (!draft.trim()) { notice('warn', lastLetter ? 'Dictez d’abord une correction' : 'Rien à rédiger : dictez d’abord'); return; }
  const key = await store.getApiKey();
  if (!key) { openSettings(); notice('error', 'Aucune clé API'); return; }
  writing = true;
  setState('writing');
  const cfg = store.settings.courrier;
  console.log(`rédaction : ${draft.length} caractères de dictée${lastLetter ? ' + courrier précédent' : ''} (${cfg.draftModel})`);
  try {
    const r = await writeLetter(key, cfg, { dictation: draft, previousLetter: lastLetter });
    if (!r.text) throw new Error('réponse vide');
    const usage = store.addUsage({ letters: 1, textInputTokens: r.inputTokens, textOutputTokens: r.outputTokens, usd: textCost(cfg.draftModel, r.inputTokens, r.outputTokens) });
    send('usage', usage);
    if (tray) tray.refresh();
    lastLetter = r.text;
    lastText = r.text;
    rememberDictated(r.text, path.join(app.getPath('userData'), 'dictations', 'courrier-' + Date.now()));
    draft = '';
    sendDraft();
    send('liveText', { text: r.text, final: true });
    console.log(`rédaction : ${r.text.length} caractères, ${r.inputTokens}/${r.outputTokens} jetons`);
    await pasteText(r.text);
  } catch (e) {
    console.error('rédaction : échec', e.message);
    setState('error', e.message);
    notice('error', e.message);
  } finally {
    writing = false;
  }
}

function showRightsDialog(e) {
  if (rightsDialogShown) return;
  rightsDialogShown = true;
  let message;
  let url;
  if (e.missingAutomationRights) {
    message = 'Autorisez « Dictopen » à piloter « System Events » : Réglages Système → Confidentialité et sécurité → Automatisation.';
    url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';
  } else if (e.missingAccessibilityRights) {
    message = 'Ajoutez (ou désactivez puis réactivez) « Dictopen » dans Réglages Système → Confidentialité et sécurité → Accessibilité.';
    url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
  } else {
    message = `Le collage a échoué : ${e.message}`;
  }
  if (process.platform === 'win32') message = `Le collage a échoué : ${e.message}. Le texte a été copié dans le presse-papiers (Ctrl+V pour le coller).`;
  dialog.showMessageBox({ type: 'warning', message: 'Collage dans l’application active', detail: message, buttons: url ? ['Ouvrir les réglages', 'Plus tard'] : ['OK'] })
    .then(({ response }) => { if (url && response === 0) shell.openExternal(url); rightsDialogShown = false; });
}

// --- autorisations macOS : micro, Accessibilité (frappe de touches), Automatisation (System Events) ---
const { execFile } = require('child_process');
function automationStatus() {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve('granted');
    // la première exécution déclenche la demande d'autorisation macOS ; -1743 = refusée
    execFile('osascript', ['-e', 'tell application "System Events" to count processes'], { timeout: 20000 }, (err, _out, stderr) => {
      if (!err) return resolve('granted');
      resolve(/-1743/.test(String(stderr) + String(err.message)) ? 'denied' : 'unknown');
    });
  });
}

async function checkPermissions() {
  if (process.platform !== 'darwin') return { platform: process.platform, microphone: 'granted', accessibility: 'granted', automation: 'granted', allGranted: true };
  const microphone = systemPreferences.getMediaAccessStatus('microphone');
  const accessibility = systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied';
  const automation = await automationStatus();
  const allGranted = microphone === 'granted' && accessibility === 'granted' && automation === 'granted';
  console.log(`autorisations : micro=${microphone} accessibilité=${accessibility} automatisation=${automation}`);
  return { platform: 'darwin', microphone, accessibility, automation, allGranted };
}

// fenêtre « Autorisations » : n'affiche que ce qui manque, se met à jour, se ferme quand tout est accordé
let permsWin = null;
function openPermissionsWindow() {
  if (permsWin && !permsWin.isDestroyed()) { permsWin.show(); permsWin.focus(); return; }
  permsWin = new BrowserWindow({
    width: 520, height: 330, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true,
    title: 'Autorisations — Dictopen', backgroundColor: '#f4f4f6', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  watchWindow(permsWin, 'autorisations');
  permsWin.loadFile(path.join(__dirname, '..', 'renderer', 'perms.html'));
  permsWin.on('closed', () => { permsWin = null; });
}

function closePermissionsWindow() {
  if (permsWatch) { clearInterval(permsWatch); permsWatch = null; }
  if (permsWin && !permsWin.isDestroyed()) permsWin.close();
}

// l'utilisateur ouvre les Réglages Système : on s'efface, on surveille, et on ne revient que si les droits manquent toujours après 25 s
let permsWatch = null;
function hidePermissionsWindowWhileUserActs() {
  if (!permsWin || permsWin.isDestroyed()) return;
  permsWin.hide();
  if (permsWatch) clearInterval(permsWatch);
  const hiddenAt = Date.now();
  permsWatch = setInterval(async () => {
    const st = await checkPermissions();
    if (st.allGranted) { closePermissionsWindow(); return; }
    if (Date.now() - hiddenAt > 25000 && permsWin && !permsWin.isDestroyed() && !permsWin.isVisible()) {
      permsWin.show();
      clearInterval(permsWatch); permsWatch = null;
    }
  }, 3000);
}

// demande ce qui manque via les boîtes système ; si quelque chose manque encore ensuite, ouvre la fenêtre de suivi
async function requestPermissions({ quiet = false } = {}) {
  let st = await checkPermissions();
  if (st.allGranted) return st;
  if (st.microphone !== 'granted') await systemPreferences.askForMediaAccess('microphone');
  // pas de demande système pour l'Accessibilité (sa boîte ferait doublon) : notre fenêtre de suivi guide l'utilisateur
  st = await checkPermissions();
  if (!st.allGranted) openPermissionsWindow();
  return st;
}

// --- boutons du SpeechMike ---
async function onMicButton({ type, released }) {
  const mode = store.current().recordButtonMode || 'pressed';
  if (type === 'startRecord') {
    if (mode === 'pressed') { if (released) await stopRecording(); else await startRecording(); }
    else if (!released) await toggleRecording();
    return;
  }
  if (!released) return; // les autres boutons agissent au relâchement
  const action = store.settings.speechMikeButtons[type] || 'none';
  await runAction(action);
}

async function runAction(action) {
  if (action === 'none') return;
  if (action === 'toggleBar') return toggleBar();
  if (action === 'toggleRecording') return toggleRecording();
  if (action === 'toggleMode') return toggleMode();
  if (action === 'rediger') return rediger();
  if (action === 'newDraft') return newDraft();
  if (action === 'cancel') return cancelRecording();
  if (action === 'copyLastText') return copyLastText();
  if (action === 'correctSelection') return correctSelection();
  if (action === 'openSettings') return openSettings();
  if (action.startsWith('hotkey:')) {
    try { await pressHotkey(action.slice(7)); } catch (e) { showRightsDialog(e); }
  }
}

// --- IPC ---
function setupIpc() {
  ipcMain.handle('settings:get', () => store.settings);
  ipcMain.handle('settings:defaults', () => store.defaults);
  ipcMain.handle('settings:save', (_e, partial) => {
    const before = JSON.stringify({ t: store.effectiveTranscription(), h: store.settings.hotkeys, m: store.settings.mode, p: store.currentProvider() });
    const s = store.saveSettings(partial);
    if (partial && partial.correction) applyLocalApi();
    const after = JSON.stringify({ t: store.effectiveTranscription(), h: s.hotkeys, m: s.mode, p: store.currentProvider() });
    if (before !== after) {
      registerHotkeys();
      rt.close(); // la session OpenAI sera rouverte avec la nouvelle configuration
      }
    if (barWin) barWin.webContents.send('capture', { cmd: s.transcription.keepMicrophoneOpen ? 'open' : 'close', deviceId: s.transcription.microphoneId });
    if (partial && partial.launchAtLogin !== undefined) applyLaunchAtLogin();
    if (partial && partial.recordDictations !== undefined) updateClipboardWatch();
    setState(state);
    if (tray) tray.refresh();
    return s;
  });
  ipcMain.handle('mode:set', (_e, mode) => { setMode(mode); return store.settings.mode; });
  ipcMain.handle('mode:toggle', () => { toggleMode(); return store.settings.mode; });
  ipcMain.handle('apikey:masked', (_e, provider) => store.maskedApiKey(provider || 'openai'));
  ipcMain.handle('clipboard:readText', () => clipboard.readText());
  ipcMain.handle('apikey:set', async (_e, key, provider) => { await store.setApiKey(key, provider || 'openai'); if (!provider || provider === 'openai') rt.close(); return store.maskedApiKey(provider || 'openai'); });
  ipcMain.handle('apikey:test', async (_e, provider) => {
    if (provider === 'claude-code') { const exe = findClaudeCode(); return exe ? { ok: true, message: `Claude Code trouvé : ${exe}` } : { ok: false, message: 'Claude Code introuvable : installez l’application Claude et connectez-vous' }; }
    const key = await store.getApiKey(provider || 'openai');
    if (!key) return { ok: false, message: 'aucune clé enregistrée' };
    if (provider === 'anthropic') {
      try {
        const res = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
        if (res.ok) return { ok: true, message: 'clé Anthropic valide' };
        const j = await res.json().catch(() => ({}));
        return { ok: false, message: `HTTP ${res.status} ${j.error?.message || ''}` };
      } catch (e) { return { ok: false, message: e.message }; }
    }
    try {
      const res = await fetch('https://api.openai.com/v1/models/gpt-live-transcribe', { headers: { Authorization: `Bearer ${key}` } });
      if (res.ok) return { ok: true, message: 'clé valide, modèle de transcription accessible' };
      const j = await res.json().catch(() => ({}));
      return { ok: false, message: `HTTP ${res.status} ${j.error?.message || ''}` };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  ipcMain.handle('usage:get', () => store.usage);
  ipcMain.handle('usage:reset', () => { const u = store.resetUsage(); send('usage', u); if (tray) tray.refresh(); return u; });

  ipcMain.handle('rec:start', startRecording);
  ipcMain.handle('rec:stop', stopRecording);
  ipcMain.handle('rec:toggle', toggleRecording);
  ipcMain.handle('rec:cancel', cancelRecording);
  ipcMain.handle('draft:rediger', rediger);
  ipcMain.handle('draft:new', newDraft);
  ipcMain.handle('draft:get', () => ({ text: draft, letter: lastLetter }));
  ipcMain.handle('text:copyLast', copyLastText);
  ipcMain.handle('text:correctSelection', correctSelection);
  ipcMain.handle('review:replace', (_e, text) => replaceWithReview(String(text || '')));
  ipcMain.handle('review:copy', (_e, text) => { clipboard.writeText(String(text || '')); });
  ipcMain.handle('review:close', () => closeReviewWindow());

  ipcMain.on('audio:chunk', (_e, buf) => {
    if (!recording) return;
    if (store.settings.recordDictations) pcmChunks.push(Buffer.from(buf));
    if (!rt.isOpen) return;
    try {
      rt.appendAudio(buf);
      audioBytes += buf.byteLength;
    } catch (e) {
      notice('error', e.message);
    }
  });
  ipcMain.on('audio:level', (_e, level) => { if (recording && level > peakLevel) peakLevel = level; if (barWin) barWin.webContents.send('level', level); });
  ipcMain.on('audio:device', (_e, label) => { if (label !== audioDevice) { audioDevice = label; console.log(`micro audio utilisé : ${label}`); setState(state); } });
  ipcMain.on('audio:error', (_e, msg) => { notice('error', `Micro : ${msg}`); if (recording) cancelRecording(); });

  ipcMain.on('mic:button', (_e, ev) => onMicButton(ev).catch((err) => notice('error', err.message)));
  ipcMain.on('mic:status', (_e, st) => { micStatus = st; setState(state); });
  ipcMain.on('log:info', (_e, msg) => console.log(String(msg).slice(0, 4000)));
  ipcMain.handle('hid:output', (_e, payload) => { if (barWin) barWin.webContents.send('hid:output', payload); });
  ipcMain.handle('mic:pairRequest', () => { if (barWin) barWin.webContents.send('mic:pair'); });

  ipcMain.handle('panel:set', (_e, show) => { setPanel(show); return panelShown; });
  ipcMain.handle('perms:check', () => checkPermissions());
  ipcMain.handle('perms:request', () => requestPermissions());
  ipcMain.handle('perms:close', () => closePermissionsWindow());
  ipcMain.handle('perms:openPane', (_e, pane) => {
    if (!/^Privacy_[A-Za-z]+$/.test(pane)) return;
    shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    hidePermissionsWindowWhileUserActs();
  });
  ipcMain.handle('win:settings', openSettings);
  ipcMain.handle('win:hideBar', () => { if (barWin) barWin.hide(); if (tray) tray.refresh(); });
  ipcMain.handle('app:quit', () => app.quit());
  // extension « Dictopen pour Chrome » : copiée hors de l'application (Chrome ne lit pas dans l'archive asar), dossier montré, page des extensions ouverte
  ipcMain.handle('extension:install', async () => {
    const fs = require('fs');
    const src = path.join(__dirname, '..', 'extension');
    const dest = path.join(app.getPath('userData'), 'Dictopen pour Chrome');
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(src)) fs.writeFileSync(path.join(dest, f), fs.readFileSync(path.join(src, f)));
    shell.showItemInFolder(path.join(dest, 'manifest.json'));
    const { execFile } = require('child_process');
    if (process.platform === 'darwin') {
      for (const browser of ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']) {
        if (fs.existsSync(`/Applications/${browser}.app`)) { execFile('open', ['-a', browser, browser === 'Microsoft Edge' ? 'edge://extensions' : 'chrome://extensions'], () => {}); break; }
      }
    } else if (process.platform === 'win32') {
      execFile('cmd.exe', ['/c', 'start', '', 'chrome', 'chrome://extensions'], { windowsHide: true }, () => {});
    }
    console.log(`extension copiée dans ${dest}`);
    return dest;
  });
}

// --- WebHID : autoriser le SpeechMike sans boîte de dialogue ---
function setupHidPermissions() {
  const { session } = require('electron');
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((_wc, permission) => ['hid', 'media', 'audioCapture'].includes(permission));
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(['hid', 'media', 'audioCapture'].includes(permission)));
  ses.setDevicePermissionHandler((details) => details.deviceType === 'hid');
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const dev = details.deviceList.find((d) => /speechmike|powermic|rm-40|microphone streaming/i.test(d.productName || '')) || details.deviceList[0];
    callback(dev ? dev.deviceId : '');
  });
}

// journal dans ~/Library/Logs/Dictopen/ (jamais le texte dicté)
function setupLogging() {
  const fs = require('fs');
  const dir = process.platform === 'darwin' ? path.join(app.getPath('home'), 'Library', 'Logs', 'Dictopen') : app.getPath('logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dictee_${new Date().toISOString().slice(0, 10)}.log`);
  const out = fs.createWriteStream(file, { flags: 'a' });
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      out.write(`${new Date().toISOString()} ${level.toUpperCase()} ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
    };
  }
  process.on('uncaughtException', (e) => console.error('uncaughtException', e));
  process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
  console.log(`démarrage ${app.getName()} ${app.getVersion()} (${app.isPackaged ? 'empaqueté' : 'développement'})`);
}

app.whenReady().then(() => {
  setupLogging();
  store = new Store();
  setupHidPermissions();
  setupIpc();
  try { if (app.dock) app.dock.show(); } catch (e) { console.warn('dock', e.message); }
  createAppMenu();
  createBar();
  createTray();
  registerHotkeys();
  applyLocalApi();
  applyLaunchAtLogin();
  updateClipboardWatch();
  if (!store.hasApiKey()) openSettings();
  // vérification des autorisations macOS au démarrage ; demande seulement si quelque chose manque
  // séquence de premier démarrage : droits macOS, puis accès au trousseau (clé API) pour que rien ne surgisse à la première dictée
  setTimeout(async () => {
    if (process.env.DICTOPEN_TEST_WAV) { setTimeout(() => runSelfTest(process.env.DICTOPEN_TEST_WAV), 12000); }
    // diagnostic clavier/presse-papiers : qui est au premier plan, Cmd+A puis Cmd+C, lecture par trois voies
    if (process.env.DICTOPEN_TEST_KEYS) {
      setTimeout(async () => {
        const { execFile } = require('child_process');
        const osa = (script) => new Promise((r) => execFile('osascript', ['-e', script], { encoding: 'utf8' }, (err, out, serr) => r(err ? 'ERR ' + (serr || err.message).trim() : out.trim())));
        const pb = () => new Promise((r) => execFile('pbpaste', [], { encoding: 'utf8' }, (err, out) => r(err ? 'ERR' : String(out.length))));
        console.log('diag : premier plan =', await osa('tell application "System Events" to get name of first application process whose frontmost is true'));
        console.log('diag : Cmd+A →', await osa('tell application "System Events" to keystroke "a" using command down'));
        await new Promise((r) => setTimeout(r, 300));
        console.log('diag : AX sélection =', await osa('tell application "System Events"\nset p to first application process whose frontmost is true\nset e to value of attribute "AXFocusedUIElement" of p\nreturn (length of (value of attribute "AXSelectedText" of e)) as text\nend tell'));
        console.log('diag : pbpaste avant =', await pb());
        console.log('diag : Cmd+C →', await osa('tell application "System Events" to keystroke "c" using command down'));
        await new Promise((r) => setTimeout(r, 500));
        console.log('diag : pbpaste après =', await pb(), '; the clipboard =', (await osa('return length of ((the clipboard) as text)')), '; electron =', String((await clipboard.readText().catch(() => 'ERR')).length));
        console.log('diag : premier plan =', await osa('tell application "System Events" to get name of first application process whose frontmost is true'));
      }, 6000);
    }
    // auto-test de la correction : sélectionne tout dans l'application au premier plan puis corrige
    if (process.env.DICTOPEN_TEST_CORRECT) { setTimeout(async () => { try { await pressHotkey('Cmd+A'); await new Promise((r) => setTimeout(r, 500)); await correctSelection(); console.log(`auto-test correction : fenêtre affichée, état ${state}`); await new Promise((r) => setTimeout(r, 2500)); const res = await replaceWithReview(lastText); console.log(`auto-test correction : remplacement ${JSON.stringify(res)}`); } catch (e) { console.error('auto-test correction :', e.message); } }, 6000); }
    if (process.env.DICTOPEN_BATCH) { setTimeout(() => runBatch(process.env.DICTOPEN_BATCH).catch((e) => console.error('lot', e.message)), 3000); }
    try { await requestPermissions({ quiet: true }); } catch (e) { console.warn('autorisations', e.message); }
    try {
      const key = await store.getApiKey();
      console.log(key ? 'clé API lue (trousseau accessible)' : 'aucune clé API enregistrée');
      if (key) ensureConnected().catch((e) => console.warn('préconnexion OpenAI', e.message));
    } catch (e) { console.warn('trousseau', e.message); }
  }, 1500);
});

// Auto-test (développement) : DICTOPEN_TEST_WAV=<fichier WAV 24 kHz mono 16 bits> rejoue le fichier comme une dictée complète
// (même chemin que le micro : tampon, transcription, filtres, collage ou copie).
async function runSelfTest(wavPath) {
  const fs = require('fs');
  try {
    const wav = fs.readFileSync(wavPath);
    const rate = wav.readUInt32LE(24);
    if (rate !== 24000) throw new Error(`fréquence ${rate} Hz, 24000 attendue`);
    const pcm = wav.subarray(44);
    console.log(`auto-test : ${wavPath} (${(pcm.length / BYTES_PER_SECOND).toFixed(1)} s)`);
    await startRecording();
    if (!recording) throw new Error('enregistrement non démarré');
    for (let off = 0; off < pcm.length; off += 4800) {
      const chunk = pcm.subarray(off, Math.min(off + 4800, pcm.length));
      rt.appendAudio(chunk); audioBytes += chunk.length;
      peakLevel = 1;
    }
    await stopRecording();
    console.log(`auto-test : terminé, état ${state}, dernier texte : ${JSON.stringify((lastText || draft || '').slice(0, 160))}`);
  } catch (e) {
    console.error('auto-test : échec', e.message);
  }
}

// Mode lot (diagnostic) : DICTOPEN_BATCH=<dossier de WAV 24 kHz> → rejoue chaque fichier sur plusieurs moteurs OpenAI
// avec le contexte et les mots-clés des réglages, et écrit <fichier>.batch.json à côté. La clé reste dans le trousseau.
async function runBatch(dir) {
  const fs = require('fs');
  const { RealtimeTranscriber } = require('./realtime');
  const key = await store.getApiKey();
  if (!key) { console.error('lot : aucune clé API'); return; }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav') && !f.endsWith('.batch.wav')).sort();
  const base = store.settings.transcription;
  const prompt = [base.prompt, ...(base.keywords || [])].filter(Boolean).join(' ');
  console.log(`lot : ${files.length} fichiers dans ${dir}`);
  const variants = [
    { id: 'live-high', model: 'gpt-live-transcribe', delay: 'high' },
    { id: 'live-medium', model: 'gpt-live-transcribe', delay: 'medium' },
    { id: 'transcribe', model: 'gpt-transcribe' },
    { id: '4o-transcribe', model: 'gpt-4o-transcribe' },
  ];
  for (const v of variants) {
    const rtb = new RealtimeTranscriber();
    rtb.on('error', (e) => console.warn(`lot ${v.id} :`, e.message));
    try {
      await rtb.connect(key, { transcription: { ...base, model: v.model, delay: v.delay } });
    } catch (e) { console.error(`lot ${v.id} : connexion impossible`, e.message); continue; }
    let done = 0;
    for (const f of files) {
      const out = path.join(dir, f.replace(/\.wav$/, '.batch.json'));
      let results = {};
      try { results = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {}
      if (results[v.id] !== undefined) { done++; continue; }
      try {
        const pcm = fs.readFileSync(path.join(dir, f)).subarray(44);
        rtb.clear();
        for (let off = 0; off < pcm.length; off += 4800) rtb.appendAudio(pcm.subarray(off, Math.min(off + 4800, pcm.length)));
        const t0 = Date.now();
        const r = await rtb.commit(60000);
        results[v.id] = r.transcript;
        results[v.id + '_ms'] = Date.now() - t0;
      } catch (e) {
        results[v.id] = null;
        results[v.id + '_error'] = e.message;
        if (!rtb.isOpen) { try { await rtb.connect(key, { transcription: { ...base, model: v.model, delay: v.delay } }); } catch {} }
      }
      fs.writeFileSync(out, JSON.stringify(results, null, 2));
      done++;
      if (done % 20 === 0) console.log(`lot ${v.id} : ${done}/${files.length}`);
    }
    rtb.close();
    console.log(`lot ${v.id} : terminé (${done})`);
  }
  console.log('lot : fin');
}

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => { globalShortcut.unregisterAll(); rt.close(); });
app.on('activate', () => { if (!barWin) createBar(); else barWin.showInactive(); });
