'use strict';
// Tarifs OpenAI relevés le 24/10/2026 (developers.openai.com/api/docs/pricing). Estimation : à mettre à jour si les prix changent.
const TRANSCRIPTION_PER_MINUTE_USD = {
  'gpt-live-transcribe': 0.017,
  'gpt-realtime-whisper': 0.017,
  'gpt-transcribe': 0.0045,
  'gpt-4o-transcribe': 0.006,
  'gpt-4o-mini-transcribe': 0.003,
  'whisper-1': 0.006,
};

// $ par million de jetons (entrée, sortie)
const TEXT_PER_MILLION_USD = {
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-5': { input: 1.25, output: 10.0 },
  // Anthropic (estimation, à vérifier sur anthropic.com/pricing)
  'claude-sonnet-5-5': { input: 3.0, output: 15.0 },
  'claude-opus-5-5': { input: 5.0, output: 25.0 },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-code': { input: 0, output: 0 },
};

function audioCost(model, seconds) {
  const perMin = TRANSCRIPTION_PER_MINUTE_USD[model] ?? 0.017;
  return (seconds / 60) * perMin;
}

function textCost(model, inputTokens, outputTokens) {
  const p = TEXT_PER_MILLION_USD[model] ?? { input: 2.0, output: 8.0 };
  return (inputTokens * p.input + outputTokens * p.output) / 1e6;
}

module.exports = { audioCost, textCost, TRANSCRIPTION_PER_MINUTE_USD, TEXT_PER_MILLION_USD };
