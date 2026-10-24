'use strict';
// Mode Courrier : la dictée complète (brute) est confiée à un modèle texte avec le prompt maître,
// qui rend le courrier final (API Responses). Une nouvelle dictée après un courrier = correction de ce courrier.

const DEFAULT_MASTER_PROMPT = `Tu es un assistant de rédaction de courriers et de comptes rendus médicaux.

Tu reçois la transcription brute d'une dictée vocale, souvent imparfaite (erreurs de reconnaissance, hésitations, ponctuation dictée). Ton rôle est de comprendre le sens médical de la dictée et de produire directement un courrier clair, précis, fluide et prêt à être envoyé ou collé dans le dossier.

Règles :
- Corrige automatiquement les erreurs de reconnaissance vocale, l'orthographe, la grammaire et la terminologie médicale quand le contexte permet d'identifier le terme voulu avec une forte probabilité.
- N'invente aucune donnée médicale absente de la dictée ; conserve les incertitudes exprimées (« suspecté », « à confirmer »).
- Rédige en paragraphes, en suivant une logique médicale : motif → antécédents / histoire → examen clinique → examens complémentaires → analyse → proposition thérapeutique → modalités pratiques et suivi. Tu peux réorganiser la dictée dans ce sens.
- Conserve le ton et les formules dictées (en-tête, formule d'appel, formule de politesse, signature) ; n'ajoute ni coordonnées, ni titres, ni signature qui n'ont pas été dictés.
- Mentionne la date du jour quand le courrier s'y prête.
- Si une dictée vient corriger ou compléter un courrier précédent, reprends le courrier complet corrigé, en intégrant les nouvelles informations et en supprimant ce qui est devenu faux ou inutile.
- Réponds uniquement par le texte final, sans explication ni commentaire.

Personnalisez ce prompt dans les réglages : votre spécialité, votre nom pour la signature, vos formules habituelles, votre vocabulaire et les corrections de dictée fréquentes.`;

// Consignes techniques ajoutées après le prompt maître (sortie brute, collable telle quelle).
const OUTPUT_RULES = `

### CONSIGNES TECHNIQUES (prioritaires)
- Réponds uniquement par le texte du courrier, en texte brut : pas de Markdown, pas d'astérisques, pas de dièses, pas de commentaire avant ou après.
- Le texte reçu est une transcription vocale brute : la ponctuation dictée (« virgule », « point », « à la ligne », « nouveau paragraphe »…) doit être convertie en signes et sauts de ligne.`;

function todayFr() {
  return new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

async function writeLetter(apiKey, cfg, { dictation, previousLetter }) {
  const master = (cfg.masterPrompt && cfg.masterPrompt.trim()) || DEFAULT_MASTER_PROMPT;
  const instructions = `${master}${OUTPUT_RULES}\n\nDate du jour : ${todayFr()}.`;
  const input = previousLetter
    ? `COURRIER PRÉCÉDENT (à corriger et à reprendre en entier) :\n${previousLetter}\n\nNOUVELLE DICTÉE / CORRECTIONS :\n${dictation}`
    : `DICTÉE BRUTE :\n${dictation}`;
  const body = { model: cfg.draftModel, instructions, input, store: false };
  if (/^gpt-5/.test(cfg.draftModel)) body.reasoning = { effort: cfg.reasoningEffort || 'low' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`Rédaction : HTTP ${res.status} ${detail}`.trim());
  }
  const data = await res.json();
  let text = '';
  for (const out of data.output || []) {
    if (out.type !== 'message') continue;
    for (const c of out.content || []) if (c.type === 'output_text') text += c.text;
  }
  return {
    text: text.trim(),
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
}

module.exports = { writeLetter, DEFAULT_MASTER_PROMPT };
