// Dictopen pour Chrome — service worker
// Capture le texte dans la frame d'origine (sélection ou sélection automatique selon la page),
// l'envoie à Dictopen (serveur local http://127.0.0.1:<port>, clé API déjà enregistrée dans Dictopen),
// affiche le résultat dans la frame principale et relaie le remplacement vers la frame d'origine.
// Dérivé de l'extension Correcteur Claude : même logique Follow (variables Slate) et même panneau.

// config.js : écrit par Dictopen à l'installation (bouton « Installer ») ; porte le jeton de l'API locale.
// Absent quand l'extension est chargée depuis le dépôt : le jeton se colle alors dans les options.
try { importScripts("config.js"); } catch {}
// pseudo.js : masquage local des identifiants (nom, date de naissance, NIR, téléphone, courriel, adresse) avant envoi
importScripts("pseudo.js");

// afficherEnvoi : volet « Envoyé à Dictopen » dans le panneau (vérification : aucun nom de patient ne doit y figurer)
// envoiDirect : hors Follow, envoyer sans confirmation le texte choisi automatiquement (option, avec avertissement)
const DEFAUTS = { niveau: "ortho", paragraphes: "supprimer", port: 47395, afficherEnvoi: true, jeton: "", envoiDirect: false };

// ---------------------------------------------------------------- jeton partagé avec Dictopen
// Chaque requête porte le jeton (en-tête X-Dictopen-Token, ou ?token= pour le WebSocket) ; et avant d'envoyer du texte,
// l'extension vérifie que c'est bien Dictopen qui répond sur le port : défi nonce → HMAC-SHA256(jeton, nonce).
async function jeton() {
  const { jeton: colle } = await chrome.storage.local.get(DEFAUTS);
  return (typeof self.DICTOPEN_TOKEN === "string" && self.DICTOPEN_TOKEN) || (colle || "").trim();
}
const hex = octets => [...new Uint8Array(octets)].map(b => b.toString(16).padStart(2, "0")).join("");
async function hmac(cle, message) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(cle), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}
const MSG_JETON = "Jeton manquant ou différent : dans Dictopen → ⚙ Réglages → Corriger la sélection, cliquez « Installer » (ou copiez le jeton dans les options de l'extension), puis rechargez l'extension.";
// { ok } ou { ok:false, erreur } : Dictopen est-il bien celui qui répond sur ce port ?
async function verifierDictopen(base, cle) {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  let res, rep;
  try {
    res = await fetch(`${base}/status?nonce=${nonce}`, { headers: { "X-Dictopen-Token": cle }, cache: "no-store" });
    rep = await res.json().catch(() => null);
  } catch {
    return { ok: false, erreur: null }; // injoignable : message générique de l'appelant
  }
  if (res.status === 401 || rep?.code === "token") return { ok: false, erreur: MSG_JETON };
  if (!res.ok || !rep?.ok) return { ok: false, erreur: `Dictopen a répondu ${res.status}.` };
  if (!rep.proof || rep.proof !== await hmac(cle, nonce)) {
    return { ok: false, erreur: "Le programme qui répond sur le port de Dictopen n'a pas prouvé son identité (jeton différent) : rien n'a été envoyé." };
  }
  return { ok: true };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "corriger", title: "Corriger avec Dictopen", contexts: ["selection"] });
  chrome.contextMenus.create({ id: "diagnostic", title: "Diagnostic de la zone (structure anonymisée)", contexts: ["all"] });
  chrome.contextMenus.create({ id: "reduxStart", title: "Diagnostic Follow : observer les actions (60 s)", contexts: ["all"] });
  chrome.contextMenus.create({ id: "reduxStop", title: "Diagnostic Follow : récupérer le relevé", contexts: ["all"] });
  chrome.contextMenus.create({ id: "reduxStruct", title: "Diagnostic Follow : structure des réponses", contexts: ["all"] });
  chrome.alarms.create("dictopen", { periodInMinutes: 0.5 });
  connecter();
  injecterPartout();
});

// À l'installation ou à la mise à jour, Chrome n'injecte pas le script de contenu dans les pages déjà ouvertes :
// on le fait nous-mêmes (le script ignore une seconde injection), pour que l'extension marche sans recharger les pages.
async function injecterPartout() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).catch(() => []);
  for (const t of tabs) {
    if (t.id == null) continue;
    chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ["content.js"] }).catch(() => {});
  }
}
chrome.runtime.onStartup.addListener(connecter);
chrome.alarms.onAlarm.addListener(a => { if (a.name === "dictopen") connecter(); });

// ---------------------------------------------------------------- liaison permanente avec Dictopen
// Le bouton « Corriger » de Dictopen (navigateur au premier plan) envoie « correct » par WebSocket :
// la correction se lance dans l'onglet actif, sans raccourci clavier. Reconnexion par l'alarme (le service worker
// peut être arrêté par Chrome) ; les « ping » de Dictopen le maintiennent actif.
let ws = null, connexionEnCours = false;
// trace envoyée à Dictopen (journal de l'application) : permet de diagnostiquer sans ouvrir la console de l'extension
function journal(texte) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "log", text: String(texte).slice(0, 500) })); } catch {}
}
async function connecter() {
  if (connexionEnCours || (ws && (ws.readyState === 0 || ws.readyState === 1))) return;
  connexionEnCours = true;
  const { port } = await chrome.storage.local.get(DEFAUTS);
  const cle = await jeton();
  if (!cle) { connexionEnCours = false; return; } // pas de jeton : l'alarme réessaiera (options → jeton, ou réinstallation)
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port || DEFAUTS.port}/?token=${encodeURIComponent(cle)}`);
  } catch { ws = null; connexionEnCours = false; return; }
  // Identité du serveur : défi dès l'ouverture ; tant que la preuve HMAC n'est pas arrivée, aucun message (réglages,
  // ordre « correct ») n'est pris en compte. Un autre programme qui occuperait le port ne peut ni régler ni déclencher.
  let verifie = false;
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  ws.onopen = () => { connexionEnCours = false; ws.send(JSON.stringify({ type: "challenge", nonce })); journal("extension prête, version " + chrome.runtime.getManifest().version); };
  ws.onmessage = async e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "proof") {
      if (msg.nonce === nonce && typeof msg.proof === "string" && msg.proof === await hmac(cle, nonce)) { verifie = true; journal("liaison vérifiée (preuve du jeton)"); }
      else { journal("liaison : preuve du jeton invalide, connexion fermée"); try { ws.close(); } catch {} }
      return;
    }
    if (!verifie) return;
    if (msg.type === "settings") {
      // réglages tenus dans Dictopen (Réglages → Corriger la sélection)
      const st = {};
      if (msg.niveau === "ortho" || msg.niveau === "style") st.niveau = msg.niveau;
      if (msg.paragraphes === "supprimer" || msg.paragraphes === "garder") st.paragraphes = msg.paragraphes;
      if (typeof msg.afficherEnvoi === "boolean") st.afficherEnvoi = msg.afficherEnvoi;
      if (typeof msg.envoiDirect === "boolean") st.envoiDirect = msg.envoiDirect;
      await chrome.storage.local.set(st);
      return;
    }
    if (msg.type !== "correct") return;
    try {
      let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      journal(`ordre reçu → onglet ${tab?.id} ${tab?.url ? new URL(tab.url).hostname : "(url inconnue)"}`);
      if (tab?.id != null) await corrigerOnglet(tab.id);
    } catch (err) { journal("erreur : " + err.message); }
  };
  ws.onclose = () => { ws = null; connexionEnCours = false; setTimeout(connecter, 3000); }; // Dictopen relancé : on revient vite
  ws.onerror = () => { try { ws?.close(); } catch {} ws = null; connexionEnCours = false; };
}
connecter(); // au réveil du service worker
// jeton ou port modifiés dans les options : on se reconnecte avec les nouvelles valeurs
chrome.storage.onChanged.addListener((ch, zone) => {
  if (zone !== "local" || !(ch.jeton || ch.port)) return;
  try { ws?.close(); } catch {}
  ws = null; connexionEnCours = false;
  connecter();
});


chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (tab?.id == null) return;
  const frameId = info.frameId ?? 0;
  if (info.menuItemId === "corriger") lancer(tab.id, frameId);
  if (info.menuItemId === "reduxStart") {
    const r = await dansLaPage(tab.id, frameId, observerRedux);
    envoyer(tab.id, 0, { type: "erreur", message: r?.ok ? "Observation lancée pour 60 s : tapez quelques lettres dans une case du courrier (puis clic droit → récupérer le relevé)." : "Store Follow introuvable dans cette frame (" + (r?.erreur || "?") + ")." });
  }
  if (info.menuItemId === "reduxStop") {
    const r = await dansLaPage(tab.id, frameId, releveRedux);
    envoyer(tab.id, 0, r?.texte ? { type: "diagnostic", texte: `frame ${frameId}\n${r.texte}` } : { type: "erreur", message: "Aucun relevé : lancez d'abord l'observation." });
  }
  if (info.menuItemId === "reduxStruct") {
    const r = await dansLaPage(tab.id, frameId, structureReponses);
    envoyer(tab.id, 0, r?.texte ? { type: "diagnostic", texte: `frame ${frameId}\n${r.texte}` } : { type: "erreur", message: "Store Follow introuvable (" + (r?.erreur || "?") + ")." });
  }
  if (info.menuItemId === "diagnostic") {
    await dansLaPage(tab.id, frameId, annoterVariables); // classes visibles dans le diagnostic
    const r = await envoyer(tab.id, frameId, { type: "diagnostiquer" });
    envoyer(tab.id, 0, r?.texte
      ? { type: "diagnostic", texte: `frame ${frameId}\n${r.texte}` }
      : { type: "erreur", message: "Diagnostic impossible dans cette zone." });
  }
});

// Raccourci (Alt+Maj+C, aussi envoyé par le bouton « Corriger » de Dictopen) : la sélection si elle existe,
// sinon le texte reconnu automatiquement dans la page (courrier Follow sans en-tête, champ actif, éditeur…)
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== "corriger") return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  corrigerOnglet(tab.id);
});

// Bouton de l'extension : idem
chrome.action.onClicked.addListener(tab => { if (tab?.id != null) corrigerOnglet(tab.id); });

async function corrigerOnglet(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  const liste = frames || [{ frameId: 0 }];
  journal(`onglet ${tabId} : ${liste.length} frame(s)`);
  for (const { frameId } of liste) {
    const r = await envoyer(tabId, frameId, { type: "sonder" });
    journal(`frame ${frameId} : sonder → ${JSON.stringify(r)}`);
    if (r?.aSelection) return lancer(tabId, frameId);
  }
  for (const { frameId } of liste) {
    const r = await envoyer(tabId, frameId, { type: "selectionnerAuto" });
    journal(`frame ${frameId} : sélection auto → ${JSON.stringify(r)}`);
    if (r?.ok) return lancer(tabId, frameId, { auto: true });
  }
  envoyer(tabId, 0, { type: "erreur", message: "Aucun texte sélectionné ni champ de texte reconnu dans cette page." });
}

// Demande de remplacement venant du panneau (frame 0) → frame d'origine
chrome.runtime.onMessage.addListener((msg, sender, repondre) => {
  // Réponse du panneau de confirmation (texte choisi automatiquement hors Follow)
  if (msg.type === "confirmer" && sender.tab?.id != null) {
    const tabId = sender.tab.id, cle = "confirmation_" + tabId;
    (async () => {
      if (msg.toujours) {
        await chrome.storage.local.set({ envoiDirect: true });
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "setting", settings: { envoiDirect: true } })); } catch {} // tenu dans Dictopen
      }
      const p = (await chrome.storage.session.get(cle))[cle];
      await chrome.storage.session.remove(cle);
      if (msg.annuler) return;
      if (!p) return envoyer(tabId, 0, { type: "erreur", message: "Texte à corriger perdu : relancez la correction." });
      await corrigerTexteLibre(tabId, p);
    })();
    return;
  }
  if (msg.type !== "remplacer" || sender.tab?.id == null) return;
  const tabId = sender.tab.id, frameId = msg.frameId;
  (async () => {
    // Follow, correction non retouchée : remplacement variable par variable
    const cle = "remplacement_" + tabId;
    const op = (await chrome.storage.session.get(cle))[cle];
    // (msg.ops : réponses retouchées à la main dans le panneau)
    if (op && op.frameId === frameId && (op.corrige === msg.texte || msg.ops)) {
      const ops = op.corrige === msg.texte ? op.ops : msg.ops;
      const r = await dansLaPage(tabId, frameId, remplacerVariables, [ops, op.vides, op.blocs || [], op.runs || []]);
      journal(`remplacement : ${JSON.stringify(r)} ; réponses à mettre à jour ${ops.length}, cases vides ${op.vides.length}, paragraphes supprimés ${(op.blocs || []).length}, paragraphes réécrits ${(op.runs || []).length}`);
      if (r?.ok) await chrome.storage.session.remove(cle);
      return r;
    }
    if (op && op.frameId === frameId) {
      // Follow, texte fixe retouché à la main dans le panneau : on ne remplace jamais le courrier en bloc (les variables
      // seraient perdues) ; seules les réponses sont modifiables dans le panneau
      return { ok: false, erreur: "Sur Follow, seules vos réponses (texte entre les cases) peuvent être retouchées dans le panneau : rétablissez la proposition ou corrigez le texte fixe directement dans Follow." };
    }
    // Sinon (autre site, ou texte modifié à la main) : toute la sélection est remplacée
    let r = await envoyer(tabId, frameId, { type: "remplacer", texte: msg.texte });
    if (r?.slate) r = await dansLaPage(tabId, frameId, remplacerSlate, [r.debut, r.fin, msg.texte]);
    return r;
  })().then(r => repondre(r || { ok: false, erreur: "La frame d'origine ne répond plus." }));
  return true;
});

// ---------------------------------------------------------------- dans la page (Follow)
// Les fonctions suivantes sont injectées dans le monde de la page (world MAIN) :
// elles doivent rester autonomes (aucune référence extérieure).

// Classe chaque variable des éditeurs Slate d'après les réponses enregistrées
// dans le store Redux de Follow : réponse tapée (value texte) → « libre »,
// réponse cochée (answerId) → « coche », donnée du dossier hors questionnaire
// (elle, patient·e…) → « donnee », sans réponse → « vide ». Résultat posé en attribut data-correcteur-var.
// Diagnostic (monde de la page) : observe pendant 60 s les actions Redux de Follow pour trouver comment une réponse
// de variable est enregistrée. Relevé anonymisé : types d'actions et forme des données (chaînes → longueur, nombres → n).
function observerRedux() {
  const racine = [...document.querySelectorAll("body, body > *")]
    .map(el => el[Object.keys(el).find(k => k.startsWith("__reactContainer"))]).find(Boolean);
  let store = null;
  const pile = [racine];
  for (let n = 0; pile.length && n < 50000 && !store; n++) {
    const f = pile.pop();
    if (!f) continue;
    if (typeof f.memoizedProps?.store?.getState === "function") store = f.memoizedProps.store;
    if (f.child) pile.push(f.child);
    if (f.sibling) pile.push(f.sibling);
  }
  if (!store) return { ok: false, erreur: "store introuvable" };
  const CODE = /^[a-z_]{2,20}$/; // petits codes (questionType…) laissés en clair ; tout autre texte masqué
  const masque = (v, prof = 0) => {
    if (v == null) return String(v);
    if (typeof v === "string") return CODE.test(v) ? `"${v}"` : `str(${v.length})`;
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "num";
    if (typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return prof > 3 ? "[…]" : `[${v.slice(0, 3).map(x => masque(x, prof + 1)).join(", ")}${v.length > 3 ? ", …" + v.length : ""}]`;
    if (typeof v === "object") return prof > 3 ? "{…}" : "{" + Object.keys(v).slice(0, 12).map(k => `${k}: ${masque(v[k], prof + 1)}`).join(", ") + "}";
    return typeof v;
  };
  if (!window.__dictopenRedux) {
    const orig = store.dispatch;
    window.__dictopenRedux = { lignes: [], orig, store, fin: 0 };
    store.dispatch = function (action) {
      try {
        const d = window.__dictopenRedux;
        if (Date.now() < d.fin && d.lignes.length < 400) {
          d.lignes.push(typeof action === "function" ? "(thunk)" : `${action?.type} ${masque(action)}`);
        }
      } catch {}
      return orig.apply(this, arguments);
    };
  }
  window.__dictopenRedux.lignes = [];
  window.__dictopenRedux.fin = Date.now() + 60000;
  // clés de l'état et de la variable : aide à retrouver où vivent les réponses
  try {
    const st = store.getState();
    window.__dictopenRedux.etat = "état : " + Object.keys(st).join(", ") + " | domain : " + Object.keys(st.domain || {}).join(", ");
  } catch { window.__dictopenRedux.etat = ""; }
  return { ok: true };
}
// Structure des réponses enregistrées et des variables du courrier ouvert (valeurs masquées, sauf les petits codes
// comme questionType, utiles pour reconstruire l'action de mise à jour).
function structureReponses() {
  const racine = [...document.querySelectorAll("body, body > *")]
    .map(el => el[Object.keys(el).find(k => k.startsWith("__reactContainer"))]).find(Boolean);
  let store = null;
  const pile = [racine];
  for (let n = 0; pile.length && n < 50000 && !store; n++) {
    const f = pile.pop();
    if (!f) continue;
    if (typeof f.memoizedProps?.store?.getState === "function") store = f.memoizedProps.store;
    if (f.child) pile.push(f.child);
    if (f.sibling) pile.push(f.sibling);
  }
  if (!store) return { erreur: "store introuvable" };
  const CODE = /^[a-z_]{2,20}$/; // petits codes (ex. questionType) laissés en clair
  const masque = (v, prof = 0) => {
    if (v == null) return String(v);
    if (typeof v === "string") return CODE.test(v) ? `"${v}"` : `str(${v.length})`;
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "num";
    if (typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return prof > 4 ? "[…]" : `[${v.slice(0, 2).map(x => masque(x, prof + 1)).join(", ")}${v.length > 2 ? ", …" + v.length : ""}]`;
    if (typeof v === "object") return prof > 4 ? "{…}" : "{" + Object.keys(v).slice(0, 14).map(k => `${k}: ${masque(v[k], prof + 1)}`).join(", ") + "}";
    return typeof v;
  };
  const st = store.getState();
  const docId = new URLSearchParams(location.search).get("docId");
  const out = [`docId présent : ${!!docId}`];
  const dav = st.domain?.documentAnswerValues || {};
  out.push(`documentAnswerValues : clés ${Object.keys(dav).length} ; forme : ${masque(dav)}`.slice(0, 1500));
  const liste = (docId && dav[docId]) || Object.values(dav).flat();
  out.push(`réponses (${liste.length}) — 3 premières :`);
  for (const a of liste.slice(0, 3)) out.push("  " + masque(a));
  const det = docId && st.cache?.documentInstances?.details?.[docId];
  out.push(`cache.documentInstances.details[docId] : ${det ? masque(det).slice(0, 1800) : "absent"}`);
  const av = det?.answerValues || [];
  out.push(`answerValues (${av.length}) — 4 premières :`);
  for (const a of av.slice(0, 4)) out.push("  " + masque(a));
  out.push(`documentTemplates : ${masque(st.domain?.documentTemplates).slice(0, 1200)}`);
  out.push(`editor : ${masque(st.domain?.editor).slice(0, 600)}`);
  // props React d'une variable (fibre) : variableId, valueProps…
  // où vivent les réponses ? recherche bornée des objets { questionId, value } dans l'état
  const trouves = [];
  (function cherche(o, chemin, prof) {
    if (!o || typeof o !== "object" || prof > 7 || trouves.length > 8) return;
    if (Array.isArray(o)) { if (o.length && o[0] && typeof o[0] === "object" && "questionId" in o[0]) { trouves.push(`${chemin} : tableau de ${o.length}, ex. ${masque(o[0])}`); return; } o.slice(0, 3).forEach((x, i) => cherche(x, `${chemin}[${i}]`, prof + 1)); return; }
    if ("questionId" in o && ("value" in o || "answerId" in o)) { trouves.push(`${chemin} : ${masque(o)}`); return; }
    for (const k of Object.keys(o).slice(0, 60)) cherche(o[k], `${chemin}.${k}`, prof + 1);
  })(st, "état", 0);
  out.push(`objets réponse trouvés : ${trouves.length}`, ...trouves.map(t => "  " + t.slice(0, 400)));
  out.push(`cache : ${Object.keys(st.cache || {}).join(", ")}`);
  const me = st.cache?.medicalEvents?.details?.[det?.medicalEventId] || st.cache?.medicalEvents?.details?.[Object.keys(st.cache?.medicalEvents?.details || {})[0]];
  if (me) out.push(`medicalEvent (cache) : ${masque(me).slice(0, 1500)}`);
  const voids = document.querySelectorAll("[data-slate-void]");
  out.push(`variables dans la page : ${voids.length} (éditeurs Slate : ${document.querySelectorAll("[data-slate-editor]").length})`);
  const v = voids[0];
  if (v) {
    const cle = Object.keys(v).find(k => k.startsWith("__reactFiber"));
    let f = v[cle]; let n = 0;
    out.push("ancêtres React de la 1re variable (clés de props) :");
    while (f && n < 14) {
      const pr = f.memoizedProps;
      if (pr && typeof pr === "object" && Object.keys(pr).length) { out.push(`  ${typeof f.type === "string" ? f.type : (f.type?.displayName || f.type?.name || "?")} : ${Object.keys(pr).slice(0, 20).join(", ")}`); n++; }
      if (pr && "variableId" in pr) { out.push(`  → props variable : ${masque(pr).slice(0, 1200)}`); break; }
      f = f.return;
    }
  }
  return { texte: out.join("\n") };
}

function releveRedux() {
  const d = window.__dictopenRedux;
  if (!d) return { texte: "" };
  const comptes = {};
  for (const l of d.lignes) { const t = l.split(" ")[0]; comptes[t] = (comptes[t] || 0) + 1; }
  const texte = [d.etat, "", "actions (type : nombre) :", ...Object.entries(comptes).map(([t, n]) => `  ${t} : ${n}`), "", "détail (premières occurrences) :"];
  const vus = new Set();
  for (const l of d.lignes) { const t = l.split(" ")[0]; if (vus.has(t)) continue; vus.add(t); texte.push("  " + l.slice(0, 700)); }
  const i = d.lignes.findIndex(l => l.includes("SET_ANSWER_VALUE"));
  if (i >= 0) { texte.push("", "séquence après la première frappe (types) :"); texte.push("  " + d.lignes.slice(i, i + 40).map(l => l.split(" ")[0]).join(" → ")); }
  return { texte: texte.join("\n") };
}

function annoterVariables() {
  if (!document.querySelector("[data-slate-editor]")) return { ok: true, nb: 0 };
  const fibre = el => el && el[Object.keys(el).find(k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"))];
  // store Redux : props.store du Provider, en descendant depuis la racine React
  let store = null;
  const racine = [...document.querySelectorAll("body, body > *")]
    .map(el => el[Object.keys(el).find(k => k.startsWith("__reactContainer"))]).find(Boolean);
  const pile = [racine];
  for (let n = 0; pile.length && n < 50000 && !store; n++) {
    const f = pile.pop();
    if (!f) continue;
    if (typeof f.memoizedProps?.store?.getState === "function") store = f.memoizedProps.store;
    if (f.child) pile.push(f.child);
    if (f.sibling) pile.push(f.sibling);
  }
  if (!store) return { ok: false, erreur: "store introuvable" };

  const st = store.getState();
  const docId = new URLSearchParams(location.search).get("docId");
  const enCours = st.domain?.documentAnswerValues || {};
  const details = st.cache?.documentInstances?.details || {};
  let valeurs = docId && (enCours[docId]?.length ? enCours[docId] : details[docId]?.answerValues);
  if (!valeurs) valeurs = Object.values(enCours).flat();
  const parQuestion = new Map();
  for (const a of valeurs || []) {
    if (!parQuestion.has(a.questionId)) parQuestion.set(a.questionId, []);
    parQuestion.get(a.questionId).push(a);
  }

  let nb = 0;
  for (const ed of document.querySelectorAll("[data-slate-editor]")) {
    if (ed.parentElement.closest("[data-slate-void]")) continue;
    for (const v of ed.querySelectorAll("[data-slate-void]")) {
      if (v.parentElement.closest("[data-slate-void]")) continue;
      const marque = v.querySelector("span[mode]");
      // donnée du dossier (elle, patient·e…) : pas de titre (les questions ont
      // leur libellé en title) et pas de réponse enregistrée
      const sansTitre = !!marque && !marque.hasAttribute("title");
      let f = fibre(marque || v);
      while (f && !(f.memoizedProps && "variableId" in f.memoizedProps && "valueProps" in f.memoizedProps)) f = f.return;
      let classe = "coche";
      if (f) {
        const { variableId, valueProps } = f.memoizedProps;
        const reponses = parQuestion.get(Number(String(variableId).split("_")[1])) || [];
        if (!valueProps?.answerParts?.length) classe = "vide";
        else if (!reponses.length && sansTitre) classe = "donnee";
        else if (reponses.length && reponses.every(a => a.answerId == null && typeof a.value === "string")) classe = "libre";
      } else if (/\[par défaut\]/.test(v.textContent)) classe = "vide";
      else if (sansTitre) classe = "donnee";
      v.setAttribute("data-correcteur-var", classe);
      nb++;
    }
  }
  return { ok: true, nb };
}

// Remplace chaque réponse tapée (void) par son texte corrigé, supprime les
// variables vides et les paragraphes non remplis ; le reste n'est pas touché.
// Applique la correction dans Follow SANS transformer les variables en texte :
//  - réponses tapées (ops) : mise à jour de la réponse elle-même via l'action Redux de Follow
//    (@MEDICAL_EVENT_DOMAIN/SET_ANSWER_VALUE, questionType TEXT → POST /answer_value_instances) ; la case reste une
//    variable, réutilisée dans les autres courriers et visible dans la barre latérale ;
//  - texte fixe des paragraphes réécrits (runs) : différences minimales mot à mot appliquées dans l'éditeur Slate,
//    les attributs (gras, police) du texte conservé sont intacts, le texte inséré hérite de ceux du voisin ;
//  - cases vides (vides) et paragraphes non remplis (blocs) : retirés du courrier ;
//  - puis @RENDER/REFETCH_VARIABLE_DATA_ON_EDITOR pour réafficher les variables mises à jour.
// Exécutée dans le monde de la page : autonome.
function remplacerVariables(ops, vides, blocs = [], runs = []) {
  if (!ops.length && !vides.length && !blocs.length && !runs.length) return { ok: true };
  const Z = String.fromCharCode(0xFEFF);
  const racine = cle => [...document.querySelectorAll(`[data-slate-void][data-key="${cle}"]`)]
    .find(v => !v.parentElement.closest("[data-slate-void]"));
  const premier = racine(ops[0]?.cle ?? vides[0]) || ((blocs.length || runs.length) && document.querySelector(`[data-key="${blocs[0] || runs[0].bloc}"]`));
  if (!premier) return { ok: false, erreur: "Variables introuvables (courrier rechargé ?) : relancez la correction." };
  const hote = premier.closest("[data-slate-editor]");
  const fibre = el => el[Object.keys(el).find(k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"))];
  let editor = null;
  for (let f = fibre(hote); f; f = f.return) {
    const st = f.stateNode;
    if (st?.value?.document && typeof st.command === "function" && typeof st.select === "function") { editor = st; break; }
  }
  if (!editor) return { ok: false, erreur: "Éditeur Slate non reconnu : utilisez « Copier »." };
  // store Redux de Follow (props.store du Provider)
  let store = null;
  const conteneur = [...document.querySelectorAll("body, body > *")].map(el => el[Object.keys(el).find(k => k.startsWith("__reactContainer"))]).find(Boolean);
  const pile = [conteneur];
  for (let n = 0; pile.length && n < 50000 && !store; n++) {
    const f = pile.pop(); if (!f) continue;
    if (typeof f.memoizedProps?.store?.getState === "function") store = f.memoizedProps.store;
    if (f.child) pile.push(f.child); if (f.sibling) pile.push(f.sibling);
  }
  if (!store && ops.length) return { ok: false, erreur: "Store Follow introuvable : utilisez « Copier »." };

  const texteVariable = v => {
    const w = document.createTreeWalker(v, NodeFilter.SHOW_TEXT);
    let s = "", n, bloc = null;
    while ((n = w.nextNode())) {
      if (n.parentElement.closest("[data-slate-spacer]")) continue;
      const t = n.data.split(Z).join("");
      let b = n.parentElement.closest('[data-slate-object="block"]');
      if (b && !v.contains(b)) b = null;
      if (!t && !b) continue;
      if (bloc && b !== bloc) s += "\n";
      bloc = b;
      s += t;
    }
    return s.replace(/\n[ \t]+(?=\n)/g, "\n").replace(/\n{3,}/g, "\n\n");
  };
  // questionId d'une variable (props React : variableId = "question_<id>")
  const questionIdDe = v => {
    const el = v.querySelector("span[mode]") || v;
    let f = fibre(el);
    while (f && !(f.memoizedProps && "variableId" in f.memoizedProps)) f = f.return;
    const id = f && String(f.memoizedProps.variableId);
    return id && /^question_\d+$/.test(id) ? Number(id.slice(9)) : null;
  };
  // vérifications avant toute modification
  const majs = [];
  for (const o of ops) {
    const v = racine(o.cle);
    if (!v || texteVariable(v) !== o.original) return { ok: false, erreur: "Une réponse a changé depuis la correction : relancez-la ou utilisez « Copier »." };
    const qid = questionIdDe(v);
    if (!qid) return { ok: false, erreur: "Variable sans identifiant de question : utilisez « Copier »." };
    majs.push({ questionId: qid, texte: o.texte });
  }

  // --- différences mot à mot (même découpage que le panneau) → modifications [début, fin, insertion] sur l'ancien texte
  const decouper = t => t.match(/\s+|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu) || [];
  const modifications = (ancien, nouveau) => {
    const A = decouper(ancien), B = decouper(nouveau), n = A.length, m = B.length;
    if (n * m > 4e6) return [[0, ancien.length, nouveau]];
    const L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * (m + 1) + j] = A[i] === B[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
    const edits = []; let i = 0, j = 0, pos = 0, cur = null;
    const ouvrir = () => { if (!cur) cur = [pos, pos, ""]; };
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { cur = null; pos += A[i].length; i++; j++; continue; }
      if (i < n && (j >= m || L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1])) { ouvrir(); cur[1] = pos + A[i].length; pos += A[i].length; i++; if (!edits.includes(cur)) edits.push(cur); }
      else { ouvrir(); cur[2] += B[j]; j++; if (!edits.includes(cur)) edits.push(cur); }
    }
    return edits;
  };

  try {
    editor.focus();
    // paragraphes réécrits : cases conservées, texte fixe modifié par différences, cases vides retirées
    for (const r of runs) {
      let bloc = editor.value.document.getNode(r.bloc);
      if (!bloc) return { ok: false, erreur: "Paragraphe introuvable (courrier rechargé ?) : relancez la correction." };
      // séquence réelle du paragraphe : runs de texte et variables (via le DOM pour la classe)
      const seq = []; // { type: "texte", keys: [{key, len}], texte } | { type: "void", key, classe }
      for (const node of bloc.nodes.toArray()) {
        if (node.object === "text") {
          const d = seq[seq.length - 1];
          if (d && d.type === "texte") { d.keys.push({ key: node.key, len: node.text.length }); d.texte += node.text; }
          else seq.push({ type: "texte", keys: [{ key: node.key, len: node.text.length }], texte: node.text });
        } else {
          const el = document.querySelector(`[data-slate-void][data-key="${node.key}"]`);
          const classe = (r.voids && r.voids[node.key]) || (el && el.getAttribute("data-correcteur-var")) || "coche";
          seq.push({ type: "void", key: node.key, classe });
          if (classe !== "vide") seq.push({ type: "texte", keys: [], texte: "" }); // run (éventuellement vide) après chaque variable gardée
        }
      }
      if (!seq.length || seq[0].type !== "texte") seq.unshift({ type: "texte", keys: [], texte: "" });
      // fusionne les runs séparés par une case vide (elle disparaît)
      const seq2 = [];
      for (const x of seq) {
        if (x.type === "void" && x.classe === "vide") continue;
        const d = seq2[seq2.length - 1];
        if (x.type === "texte" && d && d.type === "texte") { d.keys.push(...x.keys); d.texte += x.texte; } else seq2.push(x);
      }
      const gardes = seq2.filter(x => x.type === "void");
      const morceaux = r.nouveau.split(/\[(?:L|C|D)\d+\]/);
      if (morceaux.length !== gardes.length + 1) return { ok: false, erreur: `Structure du paragraphe non reconnue (${gardes.length} variables, ${morceaux.length - 1} marqueurs) : relancez la correction ou utilisez « Copier ».` };
      const runsTexte = seq2.filter(x => x.type === "texte");
      // applique de la fin vers le début (les positions des runs précédents restent valides)
      for (let k = runsTexte.length - 1; k >= 0; k--) {
        const run = runsTexte[k];
        let nouveau = morceaux[k].replace(/\s*\[vide\]\s*/g, " ").replace(/[ \t]{2,}/g, " ");
        if (nouveau === run.texte) continue;
        const edits = modifications(run.texte, nouveau);
        const point = off => { let acc = 0; for (const t of run.keys) { if (off <= acc + t.len) return { key: t.key, offset: off - acc }; acc += t.len; } const t = run.keys[run.keys.length - 1]; return t ? { key: t.key, offset: t.len } : null; };
        if (!run.keys.length) {
          // run vide (ex. deux variables collées) : insertion juste après la variable précédente
          if (!nouveau) continue;
          const idx = seq2.indexOf(run); const prev = seq2[idx - 1];
          const inl = prev && editor.value.document.getNode(prev.key); const t = inl && editor.value.document.getNextText(inl.getLastText().key);
          if (t) { editor.select({ anchor: { key: t.key, offset: 0 }, focus: { key: t.key, offset: 0 } }); editor.insertText(nouveau); }
          continue;
        }
        for (let e = edits.length - 1; e >= 0; e--) {
          const [deb, fin, ins] = edits[e];
          const a = point(deb), f = point(fin);
          if (!a || !f) continue;
          editor.select({ anchor: a, focus: f });
          if (fin > deb) editor.delete();
          if (ins) editor.insertText(ins);
        }
      }
    }
    // cases vides retirées (hors et dans les paragraphes réécrits)
    for (const cle of vides) {
      const doc = editor.value.document;
      const inl = doc.getNode(cle);
      if (!inl) continue;
      const prec = doc.getPreviousText(inl.getFirstText().key);
      const suiv = doc.getNextText(inl.getLastText().key);
      editor.withoutNormalizing(() => {
        editor.removeNodeByKey(inl.key);
        if (prec && suiv && /[ \t]$/.test(prec.text) && /^[ \t.,]/.test(suiv.text)) editor.removeTextByKey(prec.key, prec.text.length - 1, 1);
      });
    }
    for (const cle of blocs) if (editor.value.document.getNode(cle)) editor.removeNodeByKey(cle);
    // réponses corrigées en place (sauvegardées par Follow), puis réaffichage des variables
    for (const m of majs) store.dispatch({ type: "@MEDICAL_EVENT_DOMAIN/SET_ANSWER_VALUE", questionId: m.questionId, setAnswerValue: { questionType: "TEXT", value: m.texte } });
    if (majs.length) {
      const docId = Number(new URLSearchParams(location.search).get("docId"));
      setTimeout(() => { try { store.dispatch({ type: "@RENDER/REFETCH_VARIABLE_DATA_ON_EDITOR", documentId: docId, id: docId }); } catch {} }, 1500);
    }
  } catch (e) {
    return { ok: false, erreur: "L'éditeur a refusé la modification (" + e.message + ")." };
  }
  return { ok: true, reponsesMisesAJour: majs.length };
}

// Exécutée dans le monde de la page (accès à l'instance React/Slate).
// Éditeur Slate 0.4x (Follow) : on sélectionne via son API puis on insère,
// un paragraphe par ligne. Une seule annulation (Ctrl+Z) restaure l'original.
function remplacerSlate(debut, fin, texte) {
  const hote = document.querySelector("[data-correcteur-hote]");
  if (!hote) return { ok: false, erreur: "Éditeur introuvable : utilisez « Copier »." };
  hote.removeAttribute("data-correcteur-hote");

  const cle = Object.keys(hote).find(k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
  let editor = null;
  for (let f = cle && hote[cle]; f; f = f.return) {
    const s = f.stateNode;
    if (s?.value?.document && typeof s.command === "function" && typeof s.select === "function") { editor = s; break; }
  }
  if (!editor) return { ok: false, erreur: "Éditeur Slate non reconnu : utilisez « Copier »." };

  // positions en caractères → nœuds texte du DOM (à une frontière entre deux
  // nœuds : le suivant pour un début, le précédent pour une fin)
  const cherche = (cible, estDebut) => {
    const w = document.createTreeWalker(hote, NodeFilter.SHOW_TEXT);
    let pos = 0, n;
    while ((n = w.nextNode())) {
      if (estDebut ? cible < pos + n.data.length : cible <= pos + n.data.length) return [n, cible - pos];
      pos += n.data.length;
    }
    return null;
  };
  // nœud DOM → point Slate ; un point dans une variable (void) est reporté
  // juste avant (début) ou juste après (fin) la variable.
  const doc = editor.value.document;
  const point = ([node, offset], estDebut) => {
    const el = node.parentElement;
    // variable la plus externe (certaines contiennent un mini-éditeur Slate)
    let v = null;
    for (let e = el; e && e !== hote; e = e.parentElement) if (e.hasAttribute("data-slate-void")) v = e;
    if (v) {
      const inl = doc.getNode(v.getAttribute("data-key"));
      const t = inl && (estDebut ? doc.getPreviousText(inl.getFirstText().key) : doc.getNextText(inl.getLastText().key));
      return t ? { key: t.key, offset: estDebut ? t.text.length : 0 } : null;
    }
    const tEl = el.closest('[data-slate-object="text"]'), feuille = el.closest("[data-slate-leaf]");
    if (!tEl || !feuille) return null;
    let o = 0;
    for (const l of tEl.querySelectorAll("[data-slate-leaf]")) {
      if (l === feuille) break;
      o += l.querySelector("[data-slate-string]")?.textContent.length || 0;
    }
    if (el.hasAttribute("data-slate-string")) o += offset;
    return { key: tEl.getAttribute("data-key"), offset: o };
  };

  const dA = cherche(debut, true), dB = cherche(fin, false);
  const a = dA && point(dA, true), b = dB && point(dB, false);
  if (!a || !b) return { ok: false, erreur: "Position introuvable dans l'éditeur : utilisez « Copier »." };
  try {
    editor.focus();
    editor.select({ anchor: a, focus: b });
    editor.delete();
    texte.split(/\r?\n/).forEach((ligne, i) => {
      if (i) editor.splitBlock();
      if (ligne) editor.insertText(ligne);
    });
  } catch (e) {
    return { ok: false, erreur: "L'éditeur a refusé la modification (" + e.message + ")." };
  }
  return { ok: true };
}

function envoyer(tabId, frameId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => null);
}

let dernierEnvoi = null; // texte envoyé à Dictopen pour la correction en cours (volet de vérification, option)

// ---------------------------------------------------------------- Dictopen (serveur local)
// RÈGLE ABSOLUE : la phrase qui porte le nom du patient (« Je vous remercie de m'avoir adressé… ») et l'en-tête
// ne partent jamais. Dernier verrou avant tout envoi, quel que soit le chemin de capture.
const INTERDIT = /vous remercie de m['’] ?avoir adress|\b(cher|chère|ch[èe]re)\s+(confrère|consœur|consoeur|docteur|collègue|ami)|\bdocteur\s+\p{Lu}/iu;

async function appelerDictopen(texte, segments, contexte) {
  if (INTERDIT.test(texte)) {
    dernierEnvoi = "(ENVOI REFUSÉ : le texte contient l'en-tête ou la phrase d'adressage du patient)";
    return { ok: false, erreur: "Règle de confidentialité : le texte contient l'en-tête du courrier (nom du patient ou du destinataire). Rien n'a été envoyé." };
  }
  const reglages = await chrome.storage.local.get(DEFAUTS);
  const port = reglages.port || DEFAUTS.port;
  const base = `http://127.0.0.1:${port}`;
  const injoignable = "Dictopen injoignable : ouvrez Dictopen (menu ⚙ → « Corriger la sélection » → extension activée, port " + port + ").";
  const cle = await jeton();
  if (!cle) { dernierEnvoi = "(ENVOI REFUSÉ : jeton de l'API locale absent)"; return { ok: false, erreur: MSG_JETON }; }
  // Dictopen doit prouver qu'il connaît le jeton avant de recevoir le texte (un autre programme pourrait occuper le port)
  const v = await verifierDictopen(base, cle);
  if (!v.ok) { dernierEnvoi = "(ENVOI REFUSÉ : identité de Dictopen non vérifiée)"; return { ok: false, erreur: v.erreur || injoignable }; }
  dernierEnvoi = (contexte ? `[contexte : ${contexte}]\n` : "") + texte;
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/correct`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dictopen-Token": cle },
      body: JSON.stringify({ text: texte, level: reglages.niveau, segments, context: contexte || "" })
    });
    const rep = await res.json().catch(() => null);
    if (res.status === 401 || rep?.code === "token") return { ok: false, erreur: MSG_JETON };
    if (!res.ok || !rep?.ok) return { ok: false, erreur: rep?.error || `Dictopen a répondu ${res.status}.` };
    return { ok: true, corrige: rep.text, duree: Date.now() - t0 };
  } catch (e) {
    return { ok: false, erreur: injoignable };
  }
}

// Le modèle sépare volontiers les paragraphes par une ligne vide : si l'original
// n'en contenait pas, on les retire (sinon Slate crée des paragraphes vides).
function sansLignesAjoutees(corrige, original) {
  corrige = corrige.replace(/\r\n/g, "\n");
  return /\n[ \t]*\n/.test(original) ? corrige : corrige.replace(/\n(?:[ \t]*\n)+/g, "\n");
}

// Majuscule initiale et point final d'un segment selon son contexte :
// - début de phrase (après « . », « ! », « ? » ou en début de ligne) → majuscule ;
// - milieu de phrase (après « Il », « , »…) : si l'auteur avait écrit une
//   minuscule, on la rétablit ; une majuscule d'origine est laissée au modèle
//   (nom propre, sigle, ou faute qu'il a corrigée) ;
// - phrase qui continue après le segment : pas de point final ajouté.
function ajusterSegment(c, { s, milieu, suite }) {
  const i = c.search(/\p{L}/u), j = s.search(/\p{L}/u);
  if (i >= 0) {
    const l = c[i];
    if (!milieu) c = c.slice(0, i) + l.toLocaleUpperCase("fr") + c.slice(i + 1);
    else if (j >= 0 && s[j] === s[j].toLocaleLowerCase("fr") && s[j] !== s[j].toLocaleUpperCase("fr")) {
      c = c.slice(0, i) + l.toLocaleLowerCase("fr") + c.slice(i + 1);
    }
  }
  if (suite && !/[.!?…]$/.test(s) && /\.$/.test(c) && !/\.\.$/.test(c)) c = c.slice(0, -1);
  return c;
}

function dansLaPage(tabId, frameId, func, args = []) {
  return chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: "MAIN", func, args })
    .then(res => res[0]?.result, e => ({ ok: false, erreur: "Injection impossible (" + e.message + ")." }));
}

// Hors Follow : texte libre (sélection ou champ choisi automatiquement), masqué localement, corrigé, puis restauré.
// p : { frameId, original, masque, donnees, contexte, remplacable } (mis en attente dans storage.session si confirmation)
async function corrigerTexteLibre(tabId, p) {
  const { afficherEnvoi } = await chrome.storage.local.get(DEFAUTS);
  dernierEnvoi = null;
  envoyer(tabId, 0, { type: "attente", original: p.original });
  const rep = await appelerDictopen(p.masque, false, p.contexte);
  if (!rep.ok) return envoyer(tabId, 0, { type: "erreur", message: rep.erreur });
  const r = DictopenPseudo.restaurer(rep.corrige, p.donnees);
  if (r.manquants.length) return envoyer(tabId, 0, { type: "erreur", message: `Réponse incomplète (marqueur ${r.manquants[0]} absent) : relancez la correction.` });
  envoyer(tabId, 0, {
    type: "resultat",
    original: p.original,
    corrige: sansLignesAjoutees(r.texte, p.original),
    duree: rep.duree,
    remplacable: p.remplacable,
    frameId: p.frameId,
    libres: null,
    ...(afficherEnvoi && { envoye: dernierEnvoi ?? "" })
  });
}

// auto : le texte a été choisi par l'extension (pas de sélection de l'utilisateur)
async function lancer(tabId, frameId, { auto = false } = {}) {
  // Classe les variables Follow (tapée / cochée / vide) avant la capture
  await dansLaPage(tabId, frameId, annoterVariables);
  const { paragraphes, afficherEnvoi, envoiDirect } = await chrome.storage.local.get(DEFAUTS);
  const cap = await envoyer(tabId, frameId, { type: "capturer", paragraphes: paragraphes === "supprimer" });
  journal(`capture : ${cap?.texte?.length || 0} caractères, parties=${cap?.parties?.length ?? "-"}, remplaçable=${cap?.remplacable}${auto ? ", auto" : ""}`);
  if (!cap?.texte?.trim()) {
    return envoyer(tabId, 0, { type: "erreur", message: "Aucun texte sélectionné." });
  }
  const echec = message => envoyer(tabId, 0, { type: "erreur", message });
  dernierEnvoi = null;

  let corrige, duree = 0;
  const libres = []; // { cle, original, s, e } : réponses tapées dans le texte corrigé
  const contexte = cap.contexte ? [cap.contexte.patient && `patient : ${cap.contexte.patient}`, cap.contexte.destinataire && `destinataire du courrier : ${cap.contexte.destinataire}`].filter(Boolean).join(" ; ") : "";
  if (cap.parties) {
    // Éditeur Slate (Follow). Deux cas par paragraphe :
    // - paragraphe « mixte » (au moins une case vide ET une réponse tapée ou cochée) : envoyé en entier, cases vides
    //   marquées [vide], données du dossier remplacées par des marqueurs ; le modèle le réécrit sans les membres de
    //   phrase devenus incohérents ; le bloc est remplacé d'un seul tenant ;
    // - sinon : seules les réponses tapées (segments <sN>) partent ; texte fixe et réponses cochées restent tels quels,
    //   cases vides supprimées, paragraphes non remplis (sup) supprimés en entier.
    const parBloc = new Map();
    for (const p of cap.parties) { if (!parBloc.has(p.bloc)) parBloc.set(p.bloc, []); parBloc.get(p.bloc).push(p); }
    const mixtes = new Set();
    for (const [cle, parts] of parBloc) {
      const utiles = parts.filter(p => p.s !== "\n");
      if (utiles.some(p => p.sup)) continue;
      const vide = utiles.some(p => p.t === "vide");
      const rempli = utiles.some(p => p.t === "libre" || p.t === "coche");
      // une réponse cochée est poussée en « fixe » sans clé : on considère rempli dès qu'il y a une réponse tapée,
      // ou du texte fixe non vide avec une case vide (phrase type à nettoyer)
      if (vide && (rempli || utiles.some(p => p.t === "fixe" && /\p{L}/u.test(p.s)))) mixtes.add(cle);
    }
    const segments = []; // { s, milieu, suite } : toutes les réponses tapées (dans et hors paragraphes mixtes)
    const paras = [];    // paragraphes mixtes : { cle, s (texte avec marqueurs), legende, coches: [], donnees: [] }
    const visibles = cap.parties.filter(p => p.t !== "vide" && !p.sup);
    let paraCourant = null;
    const morceaux = []; // reconstruction du texte pour le panneau
    const nouveauSegment = (p) => {
      const [, avant, coeur, apres] = p.s.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!coeur) return null;
      const k = visibles.indexOf(p);
      const precedent = (visibles.slice(0, k).map(x => x.s).join("") + avant).replace(/[ \t]+$/, "").slice(-1);
      const suivant = (apres + visibles.slice(k + 1).map(x => x.s).join("")).replace(/^[ \t]+/, "");
      segments.push({ s: coeur, milieu: precedent !== "" && !/[\n.!?…]/.test(precedent), suite: suivant !== "" && suivant[0] !== "\n" });
      return { t: "libre", avant, i: segments.length - 1, apres, cle: p.cle, original: p.s };
    };
    for (const p of cap.parties) {
      if (mixtes.has(p.bloc) && p.s !== "\n") {
        if (!paraCourant || paraCourant.cle !== p.bloc) {
          paraCourant = { cle: p.bloc, s: "", coches: [], donnees: [], items: [] };
          paras.push(paraCourant);
          morceaux.push({ t: "para", i: paras.length - 1, cle: p.bloc });
        }
        if (p.t === "vide") { paraCourant.s += "[vide]"; paraCourant.items.push({ t: "vide" }); }
        else if (p.t === "donnee") { paraCourant.donnees.push(p.s); paraCourant.s += `[D${paraCourant.donnees.length}]`; paraCourant.items.push({ t: "donnee", s: p.s }); }
        else if (p.t === "libre") {
          const seg = nouveauSegment(p);
          if (seg) { paraCourant.s += `[L${seg.i + 1}]`; paraCourant.items.push({ t: "libre", seg }); }
          else { paraCourant.s += p.s; paraCourant.items.push({ t: "fixe", s: p.s }); }
        }
        else if (p.t === "coche") { paraCourant.coches.push(p.s); paraCourant.s += `[C${paraCourant.coches.length}]`; paraCourant.items.push({ t: "coche", s: p.s }); }
        else { paraCourant.s += p.s; paraCourant.items.push({ t: "fixe", s: p.s }); }
        continue;
      }
      if (p.t !== "libre") { morceaux.push(p); continue; }
      const seg = nouveauSegment(p);
      morceaux.push(seg || { t: "fixe", s: p.s });
    }
    let corriges = [];
    const parasCorriges = [];
    if (segments.length || paras.length) {
      const envoi = [
        ...segments.map((g, i) => `<s${i + 1}${(g.milieu ? " milieu" : "") + (g.suite ? " suite" : "")}>${g.s}</s${i + 1}>`),
        ...paras.map((q, i) => `<p${i + 1}>${q.s.replace(/^\n+|\n+$/g, "")}</p${i + 1}>` + (q.coches.length ? `\n(contenu des cases cochées du paragraphe ${i + 1} : ${q.coches.map((c, k) => `[C${k + 1}] = « ${c.trim()} »`).join(" ; ")})` : "")),
      ].join("\n");
      journal(`envoi : ${segments.length} segment(s), ${paras.length} paragraphe(s) mixte(s) sur ${parBloc.size} bloc(s) ; blocs sans clé : ${cap.parties.filter(p => !p.bloc).length}`);
      // identifiants éventuels dans les réponses tapées : masqués avant l'envoi, restaurés dans la réponse
      const masque = DictopenPseudo.pseudonymiser(envoi);
      dernierEnvoi = null;
      envoyer(tabId, 0, { type: "attente", original: cap.texte });
      const rep = await appelerDictopen(masque.texte, true, contexte);
      if (!rep.ok) return echec(rep.erreur);
      const rest = DictopenPseudo.restaurer(rep.corrige, masque.donnees);
      if (rest.manquants.length) return echec(`Réponse incomplète (marqueur ${rest.manquants[0]} absent) : relancez la correction.`);
      rep.corrige = rest.texte;
      journal(`réponse : ${(rep.corrige.match(/<s\d+/g) || []).length} segment(s), ${(rep.corrige.match(/<p\d+>/g) || []).length} paragraphe(s)`);
      for (const m of rep.corrige.matchAll(/<s(\d+)(?:\s[^>]*)?>([\s\S]*?)<\/s\1>/g)) corriges[m[1] - 1] = m[2];
      for (const m of rep.corrige.matchAll(/<p(\d+)>([\s\S]*?)<\/p\1>/g)) parasCorriges[m[1] - 1] = m[2];
      if (segments.some((_, i) => corriges[i] == null) || paras.some((_, i) => parasCorriges[i] == null)) return echec("Réponse incomplète (segment manquant) : relancez la correction.");
      corriges = corriges.map((c, i) => ajusterSegment(sansLignesAjoutees(c, segments[i].s).trim(), segments[i]));
      for (let i = 0; i < paras.length; i++) {
        const t = sansLignesAjoutees(parasCorriges[i], paras[i].s).trim().replace(/\s*\[vide\]\s*/g, " ").replace(/[ \t]{2,}/g, " ");
        // les marqueurs des variables conservées doivent tous être là, dans l'ordre
        const attendus = paras[i].s.match(/\[(?:L|C|D)\d+\]/g) || [];
        const recus = t.match(/\[(?:L|C|D)\d+\]/g) || [];
        if (attendus.join(" ") !== recus.join(" ")) return echec(`Le modèle a déplacé ou retiré une variable du paragraphe ${i + 1} : relancez la correction.`);
        // le modèle recopie parfois le contenu d'une case cochée à côté de son marqueur : on retire ce doublon
        for (const c of paras[i].coches) { const n = c.trim(); if (n.length > 8 && t.includes(n)) t = t.split(n).join(" ").replace(/[ \t]{2,}/g, " ").trim(); }
        parasCorriges[i] = t;
      }
      duree = rep.duree;
    }
    // Texte du panneau : réponses corrigées encadrées de marqueurs (U+E000…U+E001) pour les retouches à la main ;
    // paragraphes mixtes recomposés (texte fixe corrigé + cases, dans l'ordre).
    const texteLibre = (seg) => "" + seg.avant + corriges[seg.i] + seg.apres + "";
    const texteParagraphe = (q, i) => {
      let t = parasCorriges[i];
      let nL = 0, nC = 0, nD = 0;
      for (const it of q.items) {
        if (it.t === "libre") t = t.replace(`[L${it.seg.i + 1}]`, () => texteLibre(it.seg));
        else if (it.t === "coche") t = t.replace(`[C${++nC}]`, () => it.s);
        else if (it.t === "donnee") t = t.replace(`[D${++nD}]`, () => it.s);
      }
      return t;
    };
    const marque = morceaux.map(p => p.sup || p.t === "vide" ? "" : p.t === "libre" ? texteLibre(p) : p.t === "para" ? texteParagraphe(paras[p.i], p.i) : p.s).join("")
      .replace(/(\S)[ \t]{2,}/g, "$1 ").replace(/(\S) +([.,])/g, "$1$2");
    corrige = "";
    const reponsesOrdre = []; // segments dans l'ordre d'apparition du texte
    for (const p of morceaux) { if (p.t === "libre") reponsesOrdre.push(p); else if (p.t === "para") for (const it of paras[p.i].items) if (it.t === "libre") reponsesOrdre.push(it.seg); }
    let n = 0;
    for (const ch of marque) {
      if (ch === "") { const r = reponsesOrdre[n]; libres.push({ cle: r.cle, original: r.original, s: corrige.length }); }
      else if (ch === "") libres[n++].e = corrige.length;
      else corrige += ch;
    }
    // Opérations pour « Remplacer » : réponses corrigées en place (store Follow), texte fixe des paragraphes mixtes
    // modifié par différences, cases vides retirées, paragraphes non remplis supprimés.
    const tousSegments = [...morceaux.filter(p => p.t === "libre"), ...paras.flatMap(q => q.items.filter(it => it.t === "libre").map(it => it.seg))];
    const ops = tousSegments
      .map(p => ({ cle: p.cle, original: p.original, texte: (p.avant + corriges[p.i] + p.apres).replace(/^\n+|\n+$/g, "") }))
      .filter(o => o.texte !== o.original);
    // classe de chaque case du paragraphe, figée à la capture (le DOM peut être re-rendu avant « Remplacer »)
    const classesDe = (q) => { const m = {}; for (const p of cap.parties) if (p.bloc === q.cle && p.cle && p.t !== "fixe") m[p.cle] = p.t; return m; };
    const runs = paras.map((q, i) => ({ bloc: q.cle, nouveau: parasCorriges[i], voids: classesDe(q) })).filter((r, i) => r.nouveau !== paras[i].s.replace(/\s*\[vide\]\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim() || paras[i].items.some(it => it.t === "vide"));
    const vides = cap.parties.filter(p => p.t === "vide" && !p.sup).map(p => p.cle);
    const blocs = cap.blocsSuppr || [];
    await chrome.storage.session.set({ ["remplacement_" + tabId]: { frameId, corrige, ops, vides, blocs, runs } });
  } else if (/(^|\.)follow\.fr$/.test(cap.site || "")) {
    // Sécurité : sur Follow, seules les réponses tapées partent en correction. Une
    // sélection hors de l'éditeur de courrier n'est jamais envoyée telle quelle.
    return echec("Sélection hors de l'éditeur du courrier : rien n'a été envoyé.");
  } else {
    // Autre site : le texte part en entier, identifiants reconnus masqués. S'il a été choisi automatiquement
    // (aucune sélection de l'utilisateur), on montre d'abord ce qui va partir, sauf option « toujours envoyer ».
    const { texte: masque, donnees, types } = DictopenPseudo.pseudonymiser(cap.texte);
    const attente = { frameId, original: cap.texte, masque, donnees, contexte, remplacable: cap.remplacable };
    if (auto && !envoiDirect) {
      await chrome.storage.session.set({ ["confirmation_" + tabId]: attente });
      journal(`confirmation demandée : ${masque.length} caractères, masqués = ${types.join(", ") || "aucun"}`);
      return envoyer(tabId, 0, { type: "confirmer", texte: masque, types, site: cap.site || "" });
    }
    return corrigerTexteLibre(tabId, attente);
  }
  envoyer(tabId, 0, {
    type: "resultat",
    original: cap.texte,
    corrige,
    duree,
    remplacable: cap.remplacable,
    frameId,
    libres: cap.parties ? libres : null,
    ...(afficherEnvoi && { envoye: dernierEnvoi ?? "" })
  });
}
