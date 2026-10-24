'use strict';
// Transcription locale avec whisper.cpp : gestion des modèles (téléchargement), du serveur local (whisper-server)
// et de la transcription d'un énoncé PCM 16 bits 24 kHz (rééchantillonné en 16 kHz, encapsulé en WAV).
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const EventEmitter = require('events');

// Trois tailles seulement, choisies pour le français médical et la machine de l'utilisateur.
const MODELS = [
  {
    id: 'small',
    label: 'Léger',
    file: 'ggml-small-q5_1.bin',
    size: 190 * 1024 * 1024,
    description: 'Rapide sur toute machine (≈ 190 Mo). Précision moindre sur les termes rares.',
    minMemoryGB: 4,
  },
  {
    id: 'turbo',
    label: 'Recommandé',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    size: 574 * 1024 * 1024,
    description: 'Bon compromis précision / vitesse (≈ 575 Mo). Puce Apple ou PC récent.',
    minMemoryGB: 8,
  },
  {
    id: 'large',
    label: 'Précis',
    file: 'ggml-large-v3-q5_0.bin',
    size: 1080 * 1024 * 1024,
    description: 'Le plus précis, plus lent (≈ 1,1 Go). Machines puissantes, 16 Go conseillés.',
    minMemoryGB: 16,
  },
];
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

function recommendedModelId() {
  const gb = os.totalmem() / 1024 ** 3;
  const apple = process.platform === 'darwin' && process.arch === 'arm64';
  if (apple) return gb >= 24 ? 'large' : 'turbo'; // Metal : le modèle turbo reste rapide dès 8 Go
  return gb >= 16 ? 'turbo' : 'small'; // CPU seul (Windows) : turbo ≈ 4× plus lent que small
}

// --- utilitaires audio ---
function resample24kTo16k(pcm24) {
  // PCM16 LE mono 24 kHz → 16 kHz par interpolation linéaire (rapport 3:2)
  const inSamples = pcm24.length >> 1;
  const outSamples = Math.floor((inSamples * 2) / 3);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const pos = i * 1.5;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = pos - i0;
    const s0 = pcm24.readInt16LE(i0 * 2);
    const s1 = pcm24.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
}

function wavFromPcm16(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

class LocalWhisper extends EventEmitter {
  constructor({ modelsDir, binDir, logger = console }) {
    super();
    this.modelsDir = modelsDir;
    this.binDir = binDir;
    this.log = logger;
    this.proc = null;
    this.port = null;
    this.modelId = null;
    this.ready = false;
    this.downloads = new Map(); // id -> { received, total, abort }
    fs.mkdirSync(this.modelsDir, { recursive: true });
  }

  // --- binaire ---
  get serverBinary() {
    const name = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
    return path.join(this.binDir, name);
  }

  isAvailable() {
    return fs.existsSync(this.serverBinary);
  }

  // --- modèles ---
  modelPath(id) {
    const m = MODELS.find((x) => x.id === id);
    return m ? path.join(this.modelsDir, m.file) : null;
  }

  isModelInstalled(id) {
    const p = this.modelPath(id);
    const m = MODELS.find((x) => x.id === id);
    if (!p || !fs.existsSync(p)) return false;
    // un fichier nettement plus petit que prévu est un téléchargement interrompu
    return fs.statSync(p).size > m.size * 0.9;
  }

  modelsStatus() {
    return MODELS.map((m) => ({
      ...m,
      installed: this.isModelInstalled(m.id),
      downloading: this.downloads.has(m.id) ? { received: this.downloads.get(m.id).received, total: this.downloads.get(m.id).total } : null,
      recommended: m.id === recommendedModelId(),
    }));
  }

  async downloadModel(id) {
    const m = MODELS.find((x) => x.id === id);
    if (!m) throw new Error(`modèle inconnu : ${id}`);
    if (this.isModelInstalled(id)) return this.modelPath(id);
    if (this.downloads.has(id)) throw new Error('téléchargement déjà en cours');
    const dest = this.modelPath(id);
    const tmp = dest + '.part';
    const ctrl = new AbortController();
    const state = { received: 0, total: m.size, abort: () => ctrl.abort() };
    this.downloads.set(id, state);
    this.emit('download', { id, ...state });
    try {
      const res = await fetch(MODEL_BASE_URL + m.file, { signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || m.size;
      state.total = total;
      const out = fs.createWriteStream(tmp);
      const reader = res.body.getReader();
      let lastEmit = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        state.received += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        if (Date.now() - lastEmit > 300) { lastEmit = Date.now(); this.emit('download', { id, received: state.received, total: state.total }); }
      }
      await new Promise((r) => out.end(r));
      fs.renameSync(tmp, dest);
      this.log.log(`modèle ${id} téléchargé (${(state.received / 1024 / 1024).toFixed(0)} Mo)`);
      return dest;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    } finally {
      this.downloads.delete(id);
      this.emit('download', { id, received: 0, total: 0, done: true });
    }
  }

  cancelDownload(id) {
    const d = this.downloads.get(id);
    if (d) d.abort();
  }

  deleteModel(id) {
    const p = this.modelPath(id);
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
    if (this.modelId === id) this.stop();
  }

  // --- serveur ---
  async ensureServer(modelId, { language = 'fr', threads } = {}) {
    if (this.ready && this.proc && this.modelId === modelId) return;
    await this.stop();
    if (!this.isAvailable()) throw new Error('moteur local absent pour cette plateforme (whisper-server)');
    if (!this.isModelInstalled(modelId)) throw new Error('modèle local non téléchargé');
    this.port = await freePort();
    this.modelId = modelId;
    // recherche en faisceau (5) : nettement meilleure sur les noms propres et de médicaments, pour un surcoût modeste
    const args = ['-m', this.modelPath(modelId), '--host', '127.0.0.1', '--port', String(this.port), '-l', language, '-bs', '5', '-t', String(threads || Math.max(2, Math.min(8, os.cpus().length - 1)))];
    if (process.platform !== 'win32') args.push('--flash-attn');
    this.log.log(`whisper-server : démarrage (${modelId}, port ${this.port})`);
    const proc = spawn(this.serverBinary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    proc.stderr.on('data', (d) => { const s = d.toString().trim(); if (/error|failed|invalid/i.test(s)) this.log.warn('whisper-server :', s.slice(0, 300)); });
    proc.on('exit', (code) => { this.log.log(`whisper-server : arrêté (${code})`); if (this.proc === proc) { this.proc = null; this.ready = false; this.emit('status', 'stopped'); } });
    // attend que le port réponde (chargement du modèle : quelques secondes)
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error('whisper-server s’est arrêté au démarrage');
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/`, { method: 'GET' });
        if (r.status) { this.ready = true; this.emit('status', 'ready'); return; }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('whisper-server ne répond pas');
  }

  async stop() {
    this.ready = false;
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try { p.kill(); } catch {}
    }
  }

  // transcrit un énoncé PCM16 24 kHz ; renvoie { text, seconds, ms }
  async transcribe(pcm24, { prompt } = {}) {
    if (!this.ready) throw new Error('moteur local non prêt');
    const pcm16 = resample24kTo16k(pcm24);
    const wav = wavFromPcm16(pcm16, 16000);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    form.append('no_timestamps', 'true');
    if (prompt) form.append('prompt', prompt.slice(0, 800));
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`whisper-server : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = (data.text || '').trim();
    return { text, seconds: pcm16.length / 2 / 16000, ms: Date.now() - t0 };
  }
}

module.exports = { LocalWhisper, MODELS, recommendedModelId, resample24kTo16k, wavFromPcm16 };
