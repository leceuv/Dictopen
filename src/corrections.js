'use strict';
// Corrections après transcription.
// 1. Règles explicites « entendu => voulu » (mots entiers, insensibles à la casse et aux accents).
// 2. Correction phonétique : tout mot (ou groupe de mots) dont la prononciation coïncide avec un mot-clé est remplacé
//    par ce mot-clé. Couvre les fautes non prévues (« cardégique » → Kardégic, « kétoprophène » → kétoprofène).

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Forme phonétique approximative du français : on ne garde que ce qui s'entend.
const LETTER_NAMES = { x: 'iks', y: 'igrek', k: 'ka', q: 'ku', w: 'dublve', h: 'ach' };
function phonetic(word) {
  let w = stripAccents(String(word).toLowerCase()).replace(/[^a-z]/g, '');
  if (!w) return '';
  if (w.length === 1) return LETTER_NAMES[w] || w; // « X prime » → Ixprim
  w = w
    .replace(/ph/g, 'f')
    .replace(/qu/g, 'k')
    .replace(/c([eiy])/g, 's$1')
    .replace(/c/g, 'k')
    .replace(/q/g, 'k')
    .replace(/g([eiy])/g, 'j$1')
    .replace(/gu/g, 'g')
    .replace(/x/g, 'ks')
    .replace(/y/g, 'i')
    .replace(/w/g, 'v')
    .replace(/z/g, 's')
    .replace(/h/g, '')
    .replace(/ain|ein|in|un|ym|im/g, 'in')
    .replace(/an|en|am|em/g, 'an')
    .replace(/on|om/g, 'on')
    .replace(/eau|au/g, 'o')
    .replace(/ou/g, 'u')
    .replace(/oi/g, 'oa')
    .replace(/ai|ei/g, 'e')
    .replace(/eu|oe/g, 'e')
    .replace(/(.)\1+/g, '$1') // lettres doublées
    .replace(/e$/, '') // e muet final
    .replace(/([aeiouanr])[tdsp]$/, '$1') // consonne finale muette (Bankart ≈ banquart, rotateurs ≈ rotateur)
    .replace(/(.)\1+/g, '$1');
  return w;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- 1. règles explicites ---
function parseRules(lines) {
  const rules = [];
  for (const line of lines || []) {
    const m = /^(.+?)\s*=>\s*(.+)$/.exec(String(line).trim());
    if (m && m[1].trim() && m[2].trim()) rules.push({ from: m[1].trim(), to: m[2].trim() });
  }
  return rules;
}

function accentInsensitivePattern(text) {
  return text.trim().split(/\s+/).map((w) => w.split('').map((c) => {
    const base = stripAccents(c).toLowerCase();
    const variants = { a: 'aàâä', e: 'eéèêë', i: 'iîï', o: 'oôö', u: 'uùûü', c: 'cç' }[base];
    return variants ? `[${variants}${variants.toUpperCase()}]` : escapeRegExp(c);
  }).join('')).join('[\\s-]+');
}

function applyRules(text, rules) {
  let out = text;
  for (const { from, to } of rules) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${accentInsensitivePattern(from)}(?=$|[^\\p{L}\\p{N}])`, 'giu');
    out = out.replace(re, (_m, pre) => pre + to);
  }
  return out;
}

// --- 2. correction phonétique sur les mots-clés ---
// Un terme est corrigible s'il est assez long pour que l'homophonie soit significative.
function buildPhoneticIndex(terms) {
  const index = [];
  for (const term of terms || []) {
    const t = String(term).trim();
    if (!t) continue;
    const words = t.split(/[\s-]+/).filter(Boolean);
    const key = words.map(phonetic).join(' ');
    if (key.replace(/ /g, '').length < 4) continue;
    index.push({ term: t, words: words.length, key, len: key.replace(/ /g, '').length });
  }
  return index;
}

function tokenize(text) {
  // mots avec leur position ; les séparateurs sont conservés tels quels
  const tokens = [];
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu;
  let m;
  while ((m = re.exec(text))) tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  return tokens;
}

function matchesKeyword(windowWords, entry) {
  // comparaison sans tenir compte du découpage en mots (« acromio plastie » ≈ acromioplastie, « la targette » ≈ Latarjet)
  if (windowWords.some((w) => /\d/.test(w))) return false;
  const parts = windowWords.map(phonetic);
  if (parts.some((p) => !p)) return false;
  const a = parts.join(''); const b = entry.key.replace(/ /g, '');
  if (a === b) return true;
  if (windowWords.length > 1) return false; // plusieurs mots : égalité phonétique exigée
  // un seul mot : une différence tolérée à partir de 9 sons, deux à partir de 12
  const tol = b.length >= 12 ? 2 : b.length >= 9 ? 1 : 0;
  return tol > 0 && Math.abs(a.length - b.length) <= tol && levenshtein(a, b) <= tol;
}

function applyPhonetic(text, index) {
  if (!index.length) return text;
  const tokens = tokenize(text);
  const replacements = [];
  let i = 0;
  while (i < tokens.length) {
    let done = false;
    for (const size of [1, 2, 3]) {
      if (i + size > tokens.length) continue;
      const windowTokens = tokens.slice(i, i + size);
      const words = windowTokens.map((t) => t.word);
      const exact = words.join(' ');
      for (const entry of index) {
        if (Math.abs(entry.words - size) > 2) continue;
        if (exact === entry.term) { done = true; break; } // déjà correct, orthographe exacte
        const flat = (s) => stripAccents(s).toLowerCase().replace(/[\s-]+/g, '');
        if (flat(exact) === flat(entry.term) && exact.toLowerCase() === entry.term.toLowerCase()) { done = true; break; } // ne diffère que par la casse : mot courant, on ne touche pas
        // mot courant fléchi (constante, constants) qui ressemble à un mot-clé : on ne touche pas
        if (size === 1 && /^(e|s|es|ent|ente|entes)$/.test(flat(exact).slice(flat(entry.term).length)) && flat(exact).startsWith(flat(entry.term))) continue;
        const sameLetters = flat(exact) === flat(entry.term);
        if (sameLetters || matchesKeyword(words, entry)) {
          // conserve une majuscule initiale si le mot transcrit en avait une et que le terme n'impose rien
          replacements.push({ start: windowTokens[0].start, end: windowTokens[size - 1].end, to: entry.term });
          i += size - 1;
          done = true;
          break;
        }
      }
      if (done) break;
    }
    i++;
  }
  if (!replacements.length) return text;
  let out = '';
  let pos = 0;
  for (const r of replacements) { out += text.slice(pos, r.start) + r.to; pos = r.end; }
  return out + text.slice(pos);
}

function correctTranscript(text, { rules = [], keywords = [], phoneticEnabled = true } = {}) {
  let out = applyRules(text, parseRules(rules));
  if (phoneticEnabled) {
    const terms = [...keywords, ...parseRules(rules).map((r) => r.to)];
    out = applyPhonetic(out, buildPhoneticIndex(terms));
  }
  return out;
}

module.exports = { correctTranscript, phonetic, applyRules, parseRules, applyPhonetic, buildPhoneticIndex };
