'use strict';
// Petit serveur HTTP local (127.0.0.1 seulement) : l'extension « Dictopen pour Chrome » lui confie le texte à corriger,
// Dictopen le relit avec la clé API déjà enregistrée et renvoie la correction.
// Deux barrières :
//  - l'origine doit être une extension de navigateur (chrome-extension:// …) : bloque les pages web ;
//  - un jeton secret partagé (fichier local-api-token, copié dans l'extension à l'installation) doit accompagner chaque
//    requête HTTP (en-tête X-Dictopen-Token) et la connexion WebSocket (?token=…) : bloque les autres processus du poste,
//    qui peuvent forger l'en-tête Origin. En retour, GET /status?nonce=… renvoie HMAC-SHA256(jeton, nonce) : l'extension
//    vérifie ainsi que c'est bien Dictopen qui répond sur le port avant d'envoyer le moindre texte.
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const DEFAULT_PORT = 47395;

function allowedOrigin(origin) {
  return /^(chrome|moz|safari-web)-extension:\/\//.test(origin || '');
}

class LocalApi {
  constructor({ version, token, onCorrect, log }) {
    this.version = version;
    this.token = token || '';
    this.onCorrect = onCorrect; // async ({ text, level, segments }) → { text, ms }
    this.log = log || console.log;
    this.server = null;
    this.wss = null;
    this.port = DEFAULT_PORT;
  }

  // nombre d'extensions connectées (WebSocket)
  get clients() {
    return this.wss ? [...this.wss.clients].filter((c) => c.readyState === 1).length : 0;
  }

  // envoie un ordre à toutes les extensions connectées ; vrai si au moins une l'a reçu
  broadcast(msg) {
    let n = 0;
    if (this.wss) for (const c of this.wss.clients) if (c.readyState === 1) { try { c.send(JSON.stringify(msg)); n++; } catch {} }
    return n > 0;
  }

  // comparaison à temps constant avec le jeton
  tokenOk(given) {
    if (!this.token || typeof given !== 'string') return false;
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(this.token, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  proof(nonce) {
    return crypto.createHmac('sha256', this.token).update(nonce).digest('hex');
  }

  start(port = DEFAULT_PORT, token) {
    this.stop();
    if (token) this.token = token;
    if (!this.token) { this.log('api locale : pas de jeton, serveur non démarré'); return; }
    this.port = port;
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => {
      this.log(`api locale : erreur ${e.message}`);
      try { this.reply(req, res, 500, { ok: false, error: e.message }); } catch {}
    }));
    this.server.on('error', (e) => this.log(`api locale : ${e.code === 'EADDRINUSE' ? `port ${port} déjà utilisé` : e.message}`));
    // WebSocket : l'extension reste connectée ; Dictopen lui envoie « corriger » quand on clique sur Corriger devant un navigateur
    this.wss = new WebSocketServer({
      server: this.server,
      verifyClient: ({ origin, req }) => {
        if (!allowedOrigin(origin)) return false;
        let given = '';
        try { given = new URL(req.url, 'http://127.0.0.1').searchParams.get('token') || ''; } catch {}
        if (!this.tokenOk(given)) { this.log('api locale : connexion WebSocket refusée (jeton absent ou invalide)'); return false; }
        return true;
      },
    });
    this.wss.on('connection', (ws) => {
      this.log(`api locale : extension connectée (${this.clients})`);
      ws.on('close', () => this.log(`api locale : extension déconnectée (${this.clients})`));
      ws.on('message', (data) => { try { const m = JSON.parse(data.toString()); if (m.type === 'log') this.log(`extension : ${String(m.text).slice(0, 500)}`); } catch {} });
      ws.on('error', () => {});
    });
    this.pingTimer = setInterval(() => { for (const c of this.wss.clients) if (c.readyState === 1) { try { c.send('{"type":"ping"}'); } catch {} } }, 20000);
    this.server.listen(port, '127.0.0.1', () => this.log(`api locale : http://127.0.0.1:${port}`));
  }

  stop() {
    clearInterval(this.pingTimer);
    if (this.wss) { try { for (const c of this.wss.clients) c.terminate(); this.wss.close(); } catch {} this.wss = null; }
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
  }

  reply(req, res, status, body) {
    const origin = req.headers.origin || '';
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (allowedOrigin(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Dictopen-Token';
      headers['Access-Control-Max-Age'] = '600';
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  async handle(req, res) {
    const origin = req.headers.origin || '';
    if (req.method === 'OPTIONS') { this.reply(req, res, allowedOrigin(origin) ? 204 : 403, {}); return; }
    if (!allowedOrigin(origin)) { this.reply(req, res, 403, { ok: false, error: 'origine refusée' }); return; }
    if (!this.tokenOk(req.headers['x-dictopen-token'])) {
      // code 'token' : l'extension affiche la marche à suivre (copier le jeton depuis les réglages de Dictopen)
      this.reply(req, res, 401, { ok: false, error: 'jeton absent ou invalide', code: 'token' });
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/status') {
      const body = { ok: true, app: 'Dictopen', version: this.version };
      const nonce = url.searchParams.get('nonce') || '';
      if (/^[0-9a-f]{16,128}$/.test(nonce)) body.proof = this.proof(nonce);
      this.reply(req, res, 200, body);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/correct') {
      const body = await readJson(req, 2 * 1024 * 1024);
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) { this.reply(req, res, 400, { ok: false, error: 'texte vide' }); return; }
      const r = await this.onCorrect({ text, level: body.level === 'style' ? 'style' : 'ortho', segments: !!body.segments, context: typeof body.context === 'string' ? body.context.slice(0, 200) : '' });
      this.reply(req, res, 200, { ok: true, text: r.text, ms: r.ms });
      return;
    }
    this.reply(req, res, 404, { ok: false, error: 'inconnu' });
  }
}

function readJson(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('corps trop volumineux')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('JSON invalide')); } });
    req.on('error', reject);
  });
}

module.exports = { LocalApi, DEFAULT_PORT };
