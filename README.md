# Dictopen

Dictée médicale, transcription par l'API OpenAI.

Dictée médicale pour macOS et Windows : la voix est transcrite en direct par l'API OpenAI et le texte est **collé dans l'application active** (dossier patient, Word, messagerie…). Compatible avec les micros de dictée Philips SpeechMike (boutons et voyant rouge via WebHID) ou n'importe quel micro.

Chaque utilisateur utilise **sa propre clé API OpenAI** : aucun serveur intermédiaire, la facturation se fait sur son compte (environ 0,017 $ par minute de dictée avec `gpt-live-transcribe`, 0,0045 $ avec `gpt-transcribe` ; un courrier rédigé ≈ 0,01 à 0,02 $ avec `gpt-5`).

## Deux modes

- **Dictée directe** : chaque phrase dictée est collée telle quelle là où se trouve le curseur. La ponctuation dictée (« virgule », « point à la ligne », « nouveau paragraphe »…) est convertie localement.
- **Courrier** : la dictée s'accumule (plusieurs prises possibles), puis **Rédiger** confie l'ensemble à un modèle texte avec votre *prompt maître* (spécialité, formules, signature, corrections de dictée fréquentes) et colle le courrier complet. Redicter une correction puis Rédiger reprend le courrier en entier ; **Nouveau** repart de zéro.

Chaque mode a son modèle de transcription et, pour le courrier, son modèle de rédaction.

## Transcription locale (hors ligne)

Depuis la 0.4, chaque mode peut utiliser au choix l'API OpenAI ou un **moteur local** (whisper.cpp intégré, accélération Metal sur Apple Silicon, BLAS sur Windows) : l'audio ne quitte pas l'ordinateur, aucun coût, fonctionne sans réseau. Le texte arrive après le relâchement (pas d'affichage en direct). Trois modèles au choix, téléchargés à la demande depuis les réglages :

| Choix | Modèle | Taille | Pour |
|---|---|---|---|
| Léger | whisper small (q5) | ≈ 190 Mo | toute machine |
| Recommandé | whisper large-v3-turbo (q5) | ≈ 575 Mo | Apple Silicon, PC récents |
| Précis | whisper large-v3 (q5) | ≈ 1,1 Go | machines puissantes |

Le contexte et les mots-clés sont transmis au moteur local comme à OpenAI. Le moteur n'est pas fourni pour les Mac Intel (OpenAI uniquement).

## Fonctions

- Barre flottante toujours au premier plan, non focalisable (l'application cible garde le focus).
- SpeechMike / PowerMic 4 / RecMic : appuyer-parler ou marche/arrêt, boutons configurables, LED rouge pendant l'enregistrement (voir `docs/speechmike-led.md`).
- Raccourcis globaux capturés par position physique de touche (affichés tels qu'ils apparaissent sur votre clavier).
- Contexte et mots-clés transmis au modèle de transcription (terminologie, médicaments, noms propres), plus une **correction phonétique** : tout mot prononcé comme un mot-clé est remplacé par ce mot-clé (« cardégique » → Kardégic, « acromio plastie » → acromioplastie), et une table de corrections explicites « entendu => voulu ».
- Compteur de consommation estimée (minutes d'audio, énoncés, courriers, jetons).
- Clé API chiffrée par le système (trousseau macOS, DPAPI Windows). Réglages en JSON lisible.
- Journal technique sans le texte dicté.

## Installation (utilisateurs)

Téléchargez l'archive de votre plateforme dans les *Releases*, puis suivez `docs/GUIDE.md` (première ouverture, autorisations, clé API).

## Développement

```bash
npm install
npm start                 # lance l'application (Electron)
npm run install-mac       # macOS : paquet arm64 signé ad hoc, installé dans /Applications
npm run package           # macOS arm64 → out/
npm run icon-win          # Windows : icône .ico depuis icon-256.png
npm run package-win       # Windows x64 → dist/
```

Les binaires du moteur local sont dans `bin/<plateforme>-<architecture>/` (voir `docs/local.md` pour les reconstruire) et copiés comme ressources à l'empaquetage.

Structure : `src/main.js` (processus principal : état, raccourcis, IPC, collage), `src/realtime.js` (WebSocket OpenAI Realtime, mode transcription, PCM 16 bits 24 kHz, commit manuel), `src/redaction.js` (mode Courrier, API Responses), `src/local-whisper.js` (moteur local : modèles, serveur whisper.cpp, transcription), `src/inject.js` (collage : AppleScript Cmd+V sur macOS, SendKeys Ctrl+V sur Windows, presse-papiers sauvegardé puis restauré), `src/store.js` (réglages, clé, consommation), `renderer/` (barre, réglages, capture audio AudioWorklet, SpeechMike WebHID).

## Confidentialité

L'audio et le texte sont envoyés directement à l'API OpenAI avec votre clé. Vérifiez les conditions applicables à votre compte (conservation des données, résidence) avant toute dictée contenant des données de santé, et n'y dictez pas d'identité de patient si vous n'avez pas ces garanties.

## Licence

MIT — voir `LICENSE`.
