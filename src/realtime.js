'use strict';
// Client WebSocket de l'API OpenAI Realtime en mode transcription (push-to-talk, sans VAD).
const EventEmitter = require('events');
const WebSocket = require('ws');

const URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

class RealtimeTranscriber extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.ready = false;
    this.pending = []; // résolveurs des énoncés commités, dans l'ordre
    this.currentItemId = null;
    this.currentText = '';
  }

  get isOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN && this.ready;
  }

  connect(apiKey, cfg) {
    if (this.isOpen) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${apiKey}` } });
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error('Connexion OpenAI : délai dépassé'));
        try { ws.terminate(); } catch {}
      }, 10000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'session.update', session: this.sessionConfig(cfg) }));
      });
      ws.on('message', (data) => {
        let ev;
        try { ev = JSON.parse(data.toString()); } catch { return; }
        if ((ev.type === 'session.updated' || ev.type === 'transcription_session.updated') && !this.ready) {
          this.ready = true;
          clearTimeout(timer);
          this.connecting = null;
          this.emit('status', 'connected');
          resolve();
          return;
        }
        this.handleEvent(ev);
      });
      ws.on('error', (err) => {
        this.emit('error', err);
        if (!this.ready) { clearTimeout(timer); this.connecting = null; reject(err); }
      });
      ws.on('close', (code, reason) => {
        const wasReady = this.ready;
        this.ready = false;
        this.ws = null;
        this.connecting = null;
        clearTimeout(timer);
        const msg = `Connexion OpenAI fermée (${code}) ${reason || ''}`.trim();
        for (const p of this.pending.splice(0)) p.reject(new Error(msg));
        this.emit('status', 'disconnected');
        if (!wasReady) reject(new Error(msg));
      });
    });
    return this.connecting;
  }

  sessionConfig(cfg) {
    const t = cfg.transcription;
    const transcription = { model: t.model };
    if (t.prompt) transcription.prompt = t.prompt;
    if (t.keywords && t.keywords.length) transcription.keywords = t.keywords;
    if (t.languages && t.languages.length) transcription.languages = t.languages;
    if (t.delay && t.model === 'gpt-live-transcribe') transcription.delay = t.delay;
    return {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          noise_reduction: t.noiseReduction && t.noiseReduction !== 'none' ? { type: t.noiseReduction } : null,
          transcription,
          turn_detection: null,
        },
      },
    };
  }

  handleEvent(ev) {
    switch (ev.type) {
      case 'conversation.item.input_audio_transcription.delta':
        if (ev.item_id !== this.currentItemId) { this.currentItemId = ev.item_id; this.currentText = ''; }
        this.currentText += ev.delta || '';
        this.emit('delta', { itemId: ev.item_id, delta: ev.delta || '', text: this.currentText });
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const p = this.pending.shift();
        const result = { itemId: ev.item_id, transcript: ev.transcript || '', usage: ev.usage || null };
        this.emit('completed', result);
        if (p) p.resolve(result);
        break;
      }
      case 'conversation.item.input_audio_transcription.failed': {
        const p = this.pending.shift();
        const err = new Error(ev.error?.message || 'transcription échouée');
        if (p) p.reject(err); else this.emit('error', err);
        break;
      }
      case 'error': {
        const err = new Error(ev.error?.message || 'erreur OpenAI');
        err.code = ev.error?.code;
        // une erreur de commit (tampon trop court) concerne l'énoncé en attente
        if (/buffer|commit/i.test(err.message) && this.pending.length) this.pending.shift().reject(err);
        else this.emit('error', err);
        break;
      }
      default:
        break;
    }
  }

  appendAudio(pcm16Buffer) {
    if (!this.isOpen) throw new Error('non connecté');
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm16Buffer).toString('base64') }));
  }

  // Résout avec { transcript, usage } quand l'énoncé est transcrit.
  commit(timeoutMs = 30000) {
    if (!this.isOpen) return Promise.reject(new Error('non connecté'));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      const timer = setTimeout(() => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error('Transcription : délai dépassé'));
      }, timeoutMs);
      entry.resolve = (v) => { clearTimeout(timer); resolve(v); };
      entry.reject = (e) => { clearTimeout(timer); reject(e); };
      this.pending.push(entry);
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    });
  }

  clear() {
    if (this.isOpen) this.ws.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
    this.currentText = '';
  }

  close() {
    if (this.ws) { try { this.ws.close(); } catch {} }
  }
}

module.exports = { RealtimeTranscriber };
