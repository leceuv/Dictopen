# Dictopen

Dictée médicale, transcription par l'API OpenAI.

Dictée médicale pour macOS et Windows : la voix est transcrite en direct par l'API OpenAI et le texte est **collé dans l'application active** (dossier patient, Word, messagerie…). Compatible avec les micros de dictée Philips SpeechMike (boutons et voyant rouge via WebHID) ou n'importe quel micro.

Chaque utilisateur utilise **sa propre clé API OpenAI** : aucun serveur intermédiaire, la facturation se fait sur son compte (environ 0,017 $ par minute de dictée avec `gpt-live-transcribe`, 0,0045 $ avec `gpt-transcribe` ; un courrier rédigé ≈ 0,01 à 0,02 $ avec `gpt-5`).

## Deux modes

- **Dictée directe** : chaque phrase dictée est collée telle quelle là où se trouve le curseur. La ponctuation dictée (« virgule », « point à la ligne », « nouveau paragraphe »…) est convertie localement.
- **Courrier** : la dictée s'accumule (plusieurs prises possibles), puis **Rédiger** confie l'ensemble à un modèle texte avec votre *prompt maître* (spécialité, formules, signature, corrections de dictée fréquentes) et colle le courrier complet. Redicter une correction puis Rédiger reprend le courrier en entier ; **Nouveau** repart de zéro.

Chaque mode a son modèle de transcription et, pour le courrier, son modèle de rédaction.

## Fonctions

- Barre flottante toujours au premier plan, non focalisable (l'application cible garde le focus).
- SpeechMike / PowerMic 4 / RecMic : appuyer-parler ou marche/arrêt, boutons configurables, LED rouge pendant l'enregistrement (voir `docs/speechmike-led.md`).
- Raccourcis globaux capturés par position physique de touche (affichés tels qu'ils apparaissent sur votre clavier).
- Contexte et mots-clés transmis au modèle de transcription (terminologie, médicaments, noms propres), plus une **correction phonétique** : tout mot prononcé comme un mot-clé est remplacé par ce mot-clé (« cardégique » → Kardégic, « acromio plastie » → acromioplastie), et une table de corrections explicites « entendu => voulu ».
- **Corriger la sélection** : le texte sélectionné dans n'importe quelle application est relu par un modèle texte (orthographe, accords, concordance des temps, ponctuation) et proposé dans une fenêtre de relecture (différences, texte modifiable) avant remplacement. L'extension **Dictopen pour Chrome** (`extension/`, voir `docs/extension.md`) fait de même dans les logiciels web (Follow : variables du courrier, Doctolib, tout éditeur), sans sélection.
- Compteur de consommation estimée (minutes d'audio, énoncés, courriers, corrections, jetons).
- Clé API chiffrée par le système (trousseau macOS, DPAPI Windows). Réglages en JSON lisible.
- Journal technique sans le texte dicté.

## Installation (utilisateurs)

Téléchargez l'archive de votre plateforme dans les [Releases](https://github.com/leceuv/Dictopen/releases/latest), puis suivez `docs/GUIDE.md` (première ouverture, autorisations, clé API).

## Développement

```bash
npm install
npm start                 # lance l'application (Electron)
npm run install-mac       # macOS : paquet arm64 signé ad hoc, installé dans /Applications
npm run package           # macOS arm64 → out/
npm run icon-win          # Windows : icône .ico depuis icon-256.png
npm run package-win       # Windows x64 → dist/
```

Structure : `src/main.js` (processus principal : état, raccourcis, IPC, collage), `src/realtime.js` (WebSocket OpenAI Realtime, mode transcription, PCM 16 bits 24 kHz, commit manuel), `src/redaction.js` (mode Courrier, API Responses), `src/inject.js` (collage : AppleScript Cmd+V sur macOS, SendKeys Ctrl+V sur Windows, presse-papiers sauvegardé puis restauré), `src/store.js` (réglages, clé, consommation), `renderer/` (barre, réglages, capture audio AudioWorklet, SpeechMike WebHID).

## Confidentialité

L'audio et le texte sont envoyés directement à l'API OpenAI avec votre clé (pour « Corriger la sélection », à Anthropic ou à Claude Code si vous les choisissez). Vérifiez les conditions applicables à votre compte (conservation des données, résidence) avant toute dictée contenant des données de santé, et n'y dictez pas d'identité de patient si vous n'avez pas ces garanties.

Pour la correction d'un texte déjà écrit (barre ou extension Chrome), les identifiants reconnus (nom après une civilité, date de naissance, n° de sécurité sociale, téléphone, courriel, adresse) sont remplacés localement par des marqueurs avant l'envoi au modèle et restitués après (`extension/pseudo.js`). Ce masquage est heuristique : il réduit le risque sans le supprimer. L'API locale utilisée par l'extension n'accepte que les requêtes porteuses d'un jeton secret propre au poste, et l'extension vérifie que c'est bien Dictopen qui lui répond avant d'envoyer du texte.

## Licence

MIT — voir `LICENSE`.
