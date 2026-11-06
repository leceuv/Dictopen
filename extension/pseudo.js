// Pseudonymisation locale avant envoi au modèle : les identifiants reconnus (nom après une civilité, date de naissance,
// numéro de sécurité sociale, téléphone, courriel, adresse postale) sont remplacés par des marqueurs [ID1], [ID2]…,
// puis restaurés dans la réponse. Heuristique : réduit le risque, ne le supprime pas (prénom seul, nom sans civilité…).
// Fichier partagé : chargé par le service worker de l'extension (importScripts) et par Dictopen (require).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DictopenPseudo = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MOIS = '(?:janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)';
  const DATE = `(?:\\d{1,2}[\\/.\\-]\\d{1,2}[\\/.\\-]\\d{2,4}|\\d{1,2}(?:er)?\\s+${MOIS}\\s+\\d{4})`;
  // mot capitalisé (nom propre) : majuscule puis lettres, apostrophes ou traits d'union
  const NOM = "[A-ZÀ-ÖØ-Þ][\\p{L}'’-]*";

  // ordre : du plus spécifique au plus général ; `garde` = partie laissée en clair (civilité, « née le »)
  const REGLES = [
    { type: 'nom', re: new RegExp(`\\b((?:Madame|Monsieur|Mademoiselle|Mme|Mlle|Mr|Mrs|Ms|Dr|Docteur|Professeur|Pr|M)\\.?\\s+)(${NOM}(?:\\s+${NOM}){0,2})`, 'gu'), garde: 1 },
    { type: 'date de naissance', re: new RegExp(`\\b((?:n[ée]e?s?\\s+(?:le\\s+)?|date\\s+de\\s+naissance\\s*:?\\s*|DDN\\s*:?\\s*)\\b)(${DATE})`, 'giu'), garde: 1 },
    { type: 'numéro de sécurité sociale', re: /\b[12]\s?\d{2}\s?(?:0[1-9]|1[0-2]|[2-9]\d)\s?(?:\d{2}|2[AB])\s?\d{3}\s?\d{3}(?:\s?\d{2})?\b/g },
    { type: 'téléphone', re: /(?:\+33\s?[1-9]|\b0[1-9])(?:[\s.\-]?\d{2}){4}\b/g },
    { type: 'courriel', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
    { type: 'adresse', re: /\b\d{1,4}\s?(?:bis|ter)?,?\s+(?:rue|avenue|av\.|boulevard|bd|allée|allee|impasse|chemin|place|route|quai|cours|square|résidence|residence|lotissement)\b[^\n,.;]{0,60}/giu },
  ];

  const MARQUEUR = /\[ID(\d+)\]/g;

  // texte → { texte masqué, donnees: [{ marqueur, valeur, type }], types: [...] }
  function pseudonymiser(texte) {
    texte = String(texte || '');
    let n = 0;
    for (const m of texte.matchAll(MARQUEUR)) n = Math.max(n, Number(m[1])); // ne pas réutiliser un marqueur déjà présent
    const donnees = [];
    const vus = new Map(); // même valeur → même marqueur
    let out = texte;
    for (const { type, re, garde } of REGLES) {
      out = out.replace(re, (...args) => {
        const m = args[0];
        const groupes = args.slice(1, -2);
        const prefixe = garde ? groupes[garde - 1] : '';
        const valeur = garde ? groupes[garde] : m;
        if (!valeur || /\[ID\d+\]/.test(m)) return m;
        let marqueur = vus.get(valeur);
        if (!marqueur) { marqueur = `[ID${++n}]`; vus.set(valeur, marqueur); donnees.push({ marqueur, valeur, type }); }
        return prefixe + marqueur;
      });
    }
    return { texte: out, donnees, types: [...new Set(donnees.map((d) => d.type))] };
  }

  // réponse du modèle → { texte restauré, manquants: [marqueurs absents de la réponse] }
  function restaurer(texte, donnees) {
    let out = String(texte || '');
    const manquants = [];
    for (const { marqueur, valeur } of donnees || []) {
      if (!out.includes(marqueur)) { manquants.push(marqueur); continue; }
      out = out.split(marqueur).join(valeur);
    }
    return { texte: out, manquants };
  }

  return { pseudonymiser, restaurer };
});
