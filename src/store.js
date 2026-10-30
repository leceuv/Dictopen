'use strict';
// Réglages (JSON lisible), clé API (chiffrée par safeStorage = trousseau macOS) et compteur de consommation.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  // 'direct' = chaque énoncé est collé dans l'application active ; 'courrier' = la dictée s'accumule, puis « Rédiger » produit le courrier
  mode: 'direct',
  direct: {
    provider: 'openai', // 'openai' ou 'local'
    transcriptionModel: 'gpt-live-transcribe',
    delay: 'low',
    localPunctuation: true, // « virgule », « point à la ligne »… convertis localement
    recordButtonMode: 'pressed', // appuyer-parler
  },
  courrier: {
    provider: 'openai',
    transcriptionModel: 'gpt-transcribe',
    delay: 'low',
    draftModel: 'gpt-5',
    reasoningEffort: 'low',
    masterPrompt: '', // vide = prompt maître par défaut (redaction.js)
    recordButtonMode: 'toggle', // marche / arrêt
  },
  local: {
    modelId: '', // vide = modèle recommandé pour la machine
  },
  // « Corriger la sélection » : le texte sélectionné dans l'application active est relu par un modèle texte et recollé à sa place
  correction: {
    provider: 'openai', // 'openai' (clé OpenAI), 'anthropic' (clé Anthropic) ou 'claude-code' (abonnement Claude, via Claude Code installé)
    model: 'gpt-5-mini',
    anthropicModel: 'claude-sonnet-5-5',
    claudeCodeModel: 'sonnet',
    reasoningEffort: 'minimal',
    level: 'ortho', // 'ortho' (orthographe, accords, ponctuation) ou 'style' (+ légère amélioration)
    instructions: '', // consignes ajoutées au prompt de correction (ex. formules à conserver)
    // extension « Dictopen pour Chrome » : serveur local pour la correction, et raccourci de l'extension déclenché
    // par « Corriger » quand un navigateur est au premier plan (sélection automatique dans la page)
    localApi: true,
    localApiPort: 47395,
    browserShortcut: 'Alt+Shift+C',
  },
  transcription: {
    languages: ['fr'],
    prompt: 'Dictée médicale en français : compte rendu de consultation de chirurgie orthopédique.',
    // médicaments et termes très courants : aide à la reconnaissance et base de la correction phonétique ; à compléter selon la spécialité
    keywords: ['Doliprane', 'Dafalgan', 'Efferalgan', 'paracétamol', 'Ixprim', 'tramadol', 'Lamaline', 'Acupan', 'ibuprofène', 'kétoprofène', 'Bi-Profénid', 'Voltarène',
      'Kardégic', 'Aspégic', 'Plavix', 'Lovenox', 'Innohep', 'Xarelto', 'Eliquis', 'Pradaxa', 'Previscan', 'Coumadine',
      'Augmentin', 'amoxicilline', 'Pyostacine', 'Orelox', 'Ciflox', 'Flagyl', 'Zinnat',
      'Solupred', 'Cortancyl', 'Kenacort', 'Diprostène', 'Inexium', 'oméprazole', 'Zophren', 'Spasfon', 'Lévothyrox', 'Tahor', 'metformine', 'Lasilix', 'Xylocaïne', 'Bétadine', 'Exacyl'],
    // corrections déterministes appliquées après transcription : « entendu => voulu » (insensible à la casse, mots entiers)
    corrections: ['cardégique => Kardégic'],
    phoneticCorrections: true, // remplace tout mot dont la prononciation coïncide avec un mot-clé
    noiseReduction: 'near_field',
    microphoneId: '',
    keepMicrophoneOpen: false,
    stopDelayMs: 150,
  },
  hotkeys: {
    toggleRecording: '\\',
    toggleBar: 'Ctrl+Alt+H',
    toggleMode: 'Ctrl+Alt+M',
    rediger: 'Ctrl+Alt+T',
    newDraft: 'Ctrl+Alt+N',
    copyLastText: 'Ctrl+Alt+C',
    correctSelection: 'Ctrl+Alt+R',
  },
  hotkeyLabels: {}, // libellé tel que vu sur le clavier de l'utilisateur (ex. « ` » pour l'accélérateur « \\ » sur un Mac AZERTY)
  speechMikeButtons: {
    eolOrPrio: 'rediger',
    info: 'none',
    insOrOvr: 'cancel',
    playOrPause: 'none',
    rewind: 'none',
    fastForward: 'none',
    F1: 'correctSelection',
    F2: 'none',
    F3: 'newDraft',
    F4: 'toggleMode',
    rear: 'toggleBar',
  },
  injection: {
    afterPasteDelayMs: 800,
    autoSpace: true,
  },
  bar: { x: null, y: null },
  launchAtLogin: true,
  // diagnostic : enregistre chaque énoncé (audio WAV + JSON) dans le dossier de données, sur cet ordinateur seulement
  recordDictations: false,
  // LED d'enregistrement du SpeechMike II (protocole observé dans le pilote Philips SpeechControl, voir docs/speechmike-led.md) :
  // rapport de sortie 9 octets, octet 0 = 0x02, 2 bits par (LED, couleur) dans les octets 6-8 : 1/2 = clignotant, 3 = fixe.
  // Grande LED : rouge = octet 6 bits 2-3, vert = bits 0-1.
  led: {
    on: [{ reportId: 0, data: [2, 0, 0, 0, 0, 0, 0x0c, 0, 0] }],
    off: [{ reportId: 0, data: [2, 0, 0, 0, 0, 0, 0, 0, 0] }],
  },
};

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra === undefined ? base : extra;
  if (typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const k of Object.keys(extra || {})) out[k] = deepMerge(base[k], extra[k]);
  return out;
}

class Store {
  constructor() {
    this.dir = app.getPath('userData');
    fs.mkdirSync(this.dir, { recursive: true });
    this.migrateFromOldFolder();
    this.settingsFile = path.join(this.dir, 'settings.json');
    this.keyFile = path.join(this.dir, 'apikey.bin'); // clé OpenAI
    this._keys = {};
    this.usageFile = path.join(this.dir, 'usage.json');
    this.settings = deepMerge(DEFAULTS, this.migrate(this.readJson(this.settingsFile, {})));
    this.usage = this.readJson(this.usageFile, null) || this.freshUsage();
  }

  // reprise des réglages de l'ancien nom d'application (dossier « Dictée OpenAI ») ; la clé chiffrée n'est pas transférable
  // sur macOS (le trousseau est lié au nom de l'app) : elle sera redemandée.
  migrateFromOldFolder() {
    try {
      const old = path.join(path.dirname(this.dir), 'Dictée OpenAI');
      if (old === this.dir || !fs.existsSync(old) || fs.existsSync(path.join(this.dir, 'settings.json'))) return;
      for (const f of ['settings.json', 'usage.json']) {
        if (fs.existsSync(path.join(old, f))) fs.copyFileSync(path.join(old, f), path.join(this.dir, f));
      }
      if (process.platform === 'win32' && fs.existsSync(path.join(old, 'apikey.bin'))) fs.copyFileSync(path.join(old, 'apikey.bin'), path.join(this.dir, 'apikey.bin'));
      console.log('réglages repris depuis', old);
    } catch (e) {
      console.warn('migration des réglages impossible', e.message);
    }
  }

  // anciens réglages (v0.1 : secondPass, transcription.model)
  migrate(s) {
    if (!s || typeof s !== 'object') return {};
    if (s.transcription && s.transcription.model) {
      s.direct = { ...(s.direct || {}), transcriptionModel: s.transcription.model, delay: s.transcription.delay };
      delete s.transcription.model;
      delete s.transcription.delay;
    }
    if (s.localPunctuation !== undefined) {
      s.direct = { ...(s.direct || {}), localPunctuation: s.localPunctuation };
      delete s.localPunctuation;
    }
    if (s.recordButtonMode) { s.direct = { ...(s.direct || {}), recordButtonMode: s.recordButtonMode }; delete s.recordButtonMode; }
    delete s.secondPass;
    if (s.hotkeys) delete s.hotkeys.toggleSecondPass;
    if (s.speechMikeButtons) {
      for (const k of Object.keys(s.speechMikeButtons)) if (s.speechMikeButtons[k] === 'toggleSecondPass') s.speechMikeButtons[k] = DEFAULTS.speechMikeButtons[k] || 'none';
    }
    return s;
  }

  readJson(file, fallback) {
    try {
      // tolère la marque d'ordre d'octets (fichier édité avec le Bloc-notes)
      return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return fallback;
    }
  }

  writeJson(file, obj) {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  }

  get defaults() {
    return DEFAULTS;
  }

  saveSettings(partial) {
    this.settings = deepMerge(this.settings, partial);
    this.writeJson(this.settingsFile, this.settings);
    return this.settings;
  }

  // réglages du mode courant
  current() {
    return this.settings[this.settings.mode] || this.settings.direct;
  }

  // fournisseur de transcription du mode courant : 'openai' ou 'local'
  currentProvider() {
    return this.current().provider === 'local' ? 'local' : 'openai';
  }

  // réglages de transcription effectifs pour le mode courant
  effectiveTranscription() {
    const m = this.settings[this.settings.mode] || this.settings.direct;
    return { ...this.settings.transcription, model: m.transcriptionModel, delay: m.delay };
  }

  // --- clé API ---
  async encryptionReady() {
    for (let i = 0; i < 10; i++) {
      const ok = safeStorage.isAsyncEncryptionAvailable ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
      if (ok) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('Trousseau macOS indisponible (safeStorage)');
  }

  // provider : 'openai' (transcription, rédaction, correction) ou 'anthropic' (correction avec Claude)
  keyFileFor(provider) {
    return provider === 'anthropic' ? path.join(this.dir, 'apikey-anthropic.bin') : this.keyFile;
  }

  hasApiKey(provider = 'openai') {
    return fs.existsSync(this.keyFileFor(provider));
  }

  async getApiKey(provider = 'openai') {
    if (this._keys[provider] !== undefined) return this._keys[provider];
    if (!this.hasApiKey(provider)) return null;
    await this.encryptionReady();
    const buf = fs.readFileSync(this.keyFileFor(provider));
    let k;
    try {
      k = safeStorage.decryptString(buf);
    } catch (e) {
      // ne pas supprimer le fichier : un refus d'accès au trousseau est souvent passager (boîte de dialogue macOS)
      console.warn('clé API indéchiffrable pour l’instant (accès au trousseau ?) : à ressaisir si cela persiste', e.message);
      return null;
    }
    if (typeof k !== 'string') throw new Error(`clé déchiffrée invalide (${typeof k})`);
    this._keys[provider] = k.trim();
    return this._keys[provider];
  }

  async setApiKey(key, provider = 'openai') {
    if (typeof key !== 'string') throw new Error(`clé invalide (${typeof key})`);
    key = key.trim();
    delete this._keys[provider];
    if (!key) {
      if (this.hasApiKey(provider)) fs.unlinkSync(this.keyFileFor(provider));
      return;
    }
    await this.encryptionReady();
    const enc = safeStorage.encryptString(key);
    fs.writeFileSync(this.keyFileFor(provider), enc, { mode: 0o600 });
    this._keys[provider] = key;
  }

  async maskedApiKey(provider = 'openai') {
    try {
      const k = await this.getApiKey(provider);
      if (!k) return '';
      return k.slice(0, 7) + '…' + k.slice(-4);
    } catch {
      return '';
    }
  }

  // --- consommation ---
  freshUsage() {
    return { since: new Date().toISOString(), audioSeconds: 0, utterances: 0, letters: 0, corrections: 0, textInputTokens: 0, textOutputTokens: 0, usd: 0 };
  }

  addUsage(delta) {
    for (const k of ['audioSeconds', 'utterances', 'letters', 'corrections', 'textInputTokens', 'textOutputTokens', 'usd']) {
      if (delta[k]) this.usage[k] = (this.usage[k] || 0) + delta[k];
    }
    this.writeJson(this.usageFile, this.usage);
    return this.usage;
  }

  resetUsage() {
    this.usage = this.freshUsage();
    this.writeJson(this.usageFile, this.usage);
    return this.usage;
  }
}

module.exports = { Store, DEFAULTS };
