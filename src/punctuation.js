'use strict';
// Ponctuation dictée, traitement local (utilisé quand la 2ᵉ passe est désactivée).
// Volontairement prudent : « point » seul n'est converti qu'en fin de texte ou devant une majuscule.

const RULES = [
  [/\s*\b(?:point|retour|aller)\s+à\s+la\s+ligne\b[\s.]*/gi, '.\n'],
  [/\s*\bà\s+la\s+ligne\b[\s.]*/gi, '\n'],
  [/\s*\bnouveau\s+paragraphe\b[\s.]*/gi, '.\n\n'],
  [/\s*\bnouvelle\s+ligne\b[\s.]*/gi, '\n'],
  [/\s*\bpoint[\s-]+virgule\b\s*/gi, ' ; '],
  [/\s*\bpoint\s+d['’]interrogation\b\s*/gi, ' ? '],
  [/\s*\bpoint\s+d['’]exclamation\b\s*/gi, ' ! '],
  [/\s*\bpoints?\s+de\s+suspension\b\s*/gi, '… '],
  [/\s*\bdeux[\s-]+points\b\s*/gi, ' : '],
  [/\s*\bvirgule\b\s*/gi, ', '],
  [/\s*\bouvrez?\s+(?:la\s+)?parenthèse\b\s*/gi, ' ('],
  [/\s*\bfermez?\s+(?:la\s+)?parenthèse\b\s*/gi, ') '],
  [/\s*\bouvrez?\s+(?:les\s+)?guillemets\b\s*/gi, ' « '],
  [/\s*\bfermez?\s+(?:les\s+)?guillemets\b\s*/gi, ' » '],
  // « point » en fin de texte ou suivi d'une majuscule
  [/\s*\bpoint\b[.\s]*$/gi, '.'],
  [/\s*\bpoint\b[.\s]+(?=[A-ZÀ-Ý])/g, '. '],
];

function applyLocalPunctuation(text) {
  let t = text;
  for (const [re, rep] of RULES) t = t.replace(re, rep);
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
  // majuscule après un point ou en début de ligne
  t = t.replace(/(^|[.!?]\s+|\n)([a-zà-ÿ])/g, (m, p, c) => p + c.toUpperCase());
  return t;
}

module.exports = { applyLocalPunctuation };
