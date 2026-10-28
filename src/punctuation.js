'use strict';
// Ponctuation dictée, traitement local (utilisé quand la 2ᵉ passe est désactivée).
// Volontairement prudent : « point » seul n'est converti qu'en fin de texte ou devant une majuscule.

// « point » n'est pas converti quand c'est manifestement le nom commun (point de ponction, point douloureux, mise au point…)
// (« point de plus » / « point de plusieurs » sont des ponctuations suivies de « de plus » : « de » seul n'est pas un indice)
const POINT_NOUN_NEXT = /^(d['’]appui|d['’]injection|d['’]entrée|de\s+(ponction|départ|vue|repère|compression|côté|suture|fixation)|douloureux|douloureuse|fixe|sensible|précis|important|gâchette)\b/i;

const RULES = [
  [/\s*\b(?:point|retour|aller)\s+à\s+la\s+ligne\b[\s.,]*/gi, '.\n'],
  [/[,.]?\s*\bà\s+la\s+ligne\b[\s.,]*/gi, '\n'],
  [/[,.]?\s*\bnouveau\s+paragraphe\b[\s.,]*/gi, '.\n\n'],
  [/[,.]?\s*\bnouvelle\s+ligne\b[\s.,]*/gi, '\n'],
  [/[,.]?\s*\bpoint[\s-]+virgule\b[\s,.]*/gi, ' ; '],
  [/[,.]?\s*\bpoint\s+d['’]interrogation\b[\s,.]*/gi, ' ? '],
  [/[,.]?\s*\bpoint\s+d['’]exclamation\b[\s,.]*/gi, ' ! '],
  [/[,.]?\s*\bpoints?\s+de\s+suspension\b[\s,.]*/gi, '… '],
  [/[,.]?\s*\bdeux[\s-]+points\b[\s,.]*/gi, ' : '],
  [/[,.]?\s*\bvirgule\b[\s,.]*/gi, ', '],
  [/[,.]?\s*\bouvrez?\s+(?:la\s+)?parenthèse\b[\s,]*/gi, ' ('],
  [/[,.]?\s*\bfermez?\s+(?:la\s+)?parenthèse\b[\s,.]*/gi, ') '],
  [/[,.]?\s*\bouvrez?\s+(?:les\s+)?guillemets\b[\s,]*/gi, ' « '],
  [/[,.]?\s*\bfermez?\s+(?:les\s+)?guillemets\b[\s,.]*/gi, ' » '],
];

// « point » dicté : le modèle a souvent déjà mis la ponctuation (« …remis le compte rendu. Point, elle… ») → on fusionne en un seul « . »
const POINT_NOUN_PREV = /\b(au|un|le|ce|chaque|son|mon|votre|notre|leur|du|petit|même)\s*$/i; // « mise au point », « un point »
function convertSpokenPoint(text) {
  return text.replace(/([,.;:!?])?\s*\b[Pp]oint\b([.,;:]*)\s*/g, (m, before, after, offset, whole) => {
    const rest = whole.slice(offset + m.length);
    const prev = whole.slice(0, offset);
    // une ponctuation juste avant (« séances, point ») : c'est toujours la ponctuation dictée
    if (!before) {
      if (POINT_NOUN_NEXT.test(rest)) return m; // nom commun : inchangé
      if (POINT_NOUN_PREV.test(prev)) return m; // « mise au point », « un point »
      if (/^(ou|et|à|en|sur|avec)\b/i.test(rest)) return m; // « point et »… probablement un nom
    }
    return before === '?' || before === '!' ? before + ' ' : '. ';
  });
}

function applyLocalPunctuation(text) {
  let t = text;
  for (const [re, rep] of RULES) t = t.replace(re, rep);
  t = convertSpokenPoint(t);
  t = t
    .replace(/[ \t]+([,;:?!.])/g, '$1') // pas d'espace avant , . (on garde l'usage FR simple)
    .replace(/([,;:?!.])(?=[^\s\n)»])/g, '$1 ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\.\s*\./g, '.')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  t = t.replace(/\.\s*\./g, '.').replace(/,\s*\./g, '.').replace(/\s+\./g, '.').replace(/[ \t]{2,}/g, ' ').trim();
  // majuscule après un point ou en début de ligne
  t = t.replace(/(^|[.!?]\s+|\n)([a-zà-ÿ])/g, (m, p, c) => p + c.toUpperCase());
  return t;
}

module.exports = { applyLocalPunctuation };
