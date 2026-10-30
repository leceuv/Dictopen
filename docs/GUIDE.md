# Dictopen — guide d'installation (macOS et Windows)

Dictée médicale avec reconnaissance vocale OpenAI : chaque phrase dictée est collée dans l'application active (Word, Lifen, Doctolib, dossier patient…), ou bien un courrier complet est rédigé à partir de votre dictée. Compatible SpeechMike Philips (boutons et voyant rouge) ou n'importe quel micro.

Chaque utilisateur utilise **sa propre clé API OpenAI** : la dictée est facturée sur son compte (environ 0,005 $ par minute de dictée avec gpt-transcribe ; un courrier rédigé ≈ 0,02 $). Aucune donnée ne transite par un serveur intermédiaire : l'audio et le texte vont directement de votre ordinateur au fournisseur du modèle (OpenAI ; pour la fonction « Corriger », Anthropic ou Claude Code si vous les choisissez dans les réglages).

## 1. Installer

1. Choisissez le fichier selon votre Mac : **Dictopen-0.5.3-AppleSilicon.zip** (puce M1/M2/M3/M4) ou **Dictopen-0.5.3-Intel.zip** (menu  → À propos de ce Mac).
2. Double-cliquez sur le zip, puis glissez **Dictopen** dans le dossier **Applications**.
3. **Première ouverture** : l'application n'est pas signée par Apple. Faites un **clic droit (ou Ctrl+clic) sur l'app → Ouvrir → Ouvrir**. Si macOS la bloque quand même : Réglages Système → Confidentialité et sécurité → en bas, bouton « Ouvrir quand même ».

### Sur Windows

1. Décompressez **Dictopen-0.5.3-Windows.zip** où vous voulez (par exemple `C:\Program Files\Dictopen` ou votre dossier Documents), puis créez un raccourci de **Dictopen.exe** sur le Bureau ou dans la barre des tâches.
2. **Première ouverture** : Windows SmartScreen affiche « Windows a protégé votre ordinateur » (l'application n'est pas signée). Cliquez sur **Informations complémentaires** → **Exécuter quand même**. Cela n'arrive qu'une fois.
3. Aucune autorisation « Accessibilité » n'est nécessaire sous Windows : le collage utilise l'envoi de touches standard. Autorisez le micro si Windows le demande (Paramètres → Confidentialité → Microphone → applications de bureau).
4. Si vous avez un SpeechMike : fermez Dragon, SpeechControl ou tout autre logiciel de dictée avant de lancer l'app (un seul programme peut tenir les boutons).

## 2. Autorisations macOS (une seule fois)

- **Micro** : acceptez la demande au lancement.
- **Accessibilité** et **Automatisation (System Events)** : demandées au premier collage de texte. Acceptez, ou ajoutez « Dictopen » dans Réglages Système → Confidentialité et sécurité → Accessibilité. Sans ces droits, le texte est copié dans le presse-papiers au lieu d'être collé.

## 3. Clé API OpenAI

1. Sur <https://platform.openai.com> : créez un compte (ou utilisez le vôtre), ajoutez un moyen de paiement (Billing), puis **API keys → Create new secret key**. Copiez la clé (elle commence par `sk-`, affichée une seule fois). Les boutons de la section *Clé API OpenAI* des réglages ouvrent directement ces pages.
2. Dans l'app : ⚙ Réglages → **Clé API OpenAI** → bouton **Coller** → **Enregistrer** → **Tester** (doit afficher « clé valide »).
La clé est chiffrée dans le trousseau de votre Mac.

## 4. Utiliser

La barre flottante reste au-dessus des autres fenêtres (déplaçable, masquable avec ⌃⌥H ou le bouton —).

**Mode Dictée directe** (par défaut)
- Placez le curseur dans l'application cible (Word, Lifen…).
- **SpeechMike** : maintenez **Record** et parlez ; au relâchement, la phrase est collée. **Sans SpeechMike** : appuyez sur la touche affichée dans la barre (par défaut la touche `\` / `` ` `` à gauche de Retour) pour démarrer, puis à nouveau pour arrêter.
- « virgule », « point », « point à la ligne », « nouveau paragraphe » sont convertis automatiquement.

**Mode Courrier** (étiquette dans la barre, ⌃⌥M ou F4 du SpeechMike)
- Dictez toute la consultation : Record = marche/arrêt, plusieurs prises possibles ; le brouillon s'affiche dans la barre.
- **Rédiger** (bouton, EOL du SpeechMike ou ⌃⌥T) : le courrier complet est rédigé par GPT selon votre prompt maître, puis collé dans l'application active.
- Redictez une correction (« ajoute que… », « finalement l'IRM montre… ») puis Rédiger : le courrier est repris en entier. **Nouveau** (F3 ou ⌃⌥N) pour le patient suivant.

**Corriger un texte déjà écrit** (les deux modes)
- Sélectionnez le texte dans n'importe quelle application (le courrier terminé, par exemple), puis ⌃⌥R ou le bouton F1 du SpeechMike.
- Le texte est relu par GPT (orthographe, accords, concordance des temps, ponctuation, erreurs de reconnaissance évidentes) et proposé dans une fenêtre : retraits en rouge, ajouts en vert, texte modifiable ; **Remplacer** le colle à la place de la sélection.
- Dans un logiciel web (Follow, Doctolib…) : ⚙ Réglages → *Corriger la sélection* → **Installer « Dictopen pour Chrome »…** (3 clics dans Chrome, expliqués à l'écran). Ensuite, **Corriger** avec Chrome devant : sur Follow, rien à sélectionner, l'extension prend le courrier affiché sans l'en-tête (formule d'appel et phrase d'adressage, qui portent le nom du patient) et n'envoie que vos réponses tapées ; elle les corrige, retire les cases non remplies et les phrases devenues incohérentes, puis « Remplacer » réécrit le courrier dans Follow. Ailleurs, elle prend votre sélection, sinon le champ de texte actif en vous montrant d'abord ce qui va partir. Partout, les identifiants reconnus (nom après une civilité, date de naissance, n° de sécurité sociale, téléphone, courriel, adresse) sont masqués localement avant l'envoi et restitués après ; ce masquage est heuristique et ne remplace pas votre relecture.
- Le correcteur se choisit dans les réglages : OpenAI (gpt-5-mini), Claude par clé API Anthropic, ou Claude par votre abonnement Pro/Max si l'application Claude est installée (aucun coût à l'usage). Avant tout envoi, les identifiants reconnus (nom après une civilité, date de naissance, numéro de sécurité sociale, téléphone, courriel, adresse) sont remplacés localement par des marqueurs, puis restitués. Hors Follow, quand aucun texte n'est sélectionné, ce qui va partir vous est d'abord montré.
- **Mise à jour depuis la 0.5.0** : l'extension doit être réinstallée (⚙ Réglages → *Corriger la sélection* → **Installer**, puis ↻ dans `chrome://extensions`) : elle reçoit un jeton qui la lie à votre Dictopen.

## 5. Personnaliser (⚙ Réglages)

- **Prompt maître** (mode Courrier) : décrivez votre spécialité, votre nom pour la signature, vos formules et vos corrections de dictée fréquentes. C'est ce qui fait la qualité du courrier.
- **Mots-clés** : termes techniques, médicaments, noms de confrères, un par ligne. Et le **contexte** : deux ou trois phrases telles que vous les dictez réellement. Tout mot prononcé comme un mot-clé est automatiquement remplacé par ce mot-clé (correction phonétique) : il suffit donc d'ajouter le bon terme aux mots-clés. Pour un cas particulier, la table de **corrections** « entendu => voulu » force un remplacement.
- **Modèles** : par mode, choisissez la transcription (`gpt-live-transcribe` avec texte en direct, ou `gpt-transcribe` 4× moins cher) et, pour le courrier, le modèle de rédaction (`gpt-5` qualité, `gpt-5-mini` économique).
- **Boutons du SpeechMike** et **raccourcis clavier** : cliquez dans un champ et appuyez sur la touche voulue.
- **Consommation** : coût estimé depuis la dernière remise à zéro.

## 6. En cas de problème

- La souris ne clique plus : cliquez une fois sur le bouton souris du SpeechMike (bouton resté « enfoncé »).
- Le texte n'est pas collé mais copié : vérifiez Accessibilité et Automatisation (§2) ; si l'app a été mise à jour, désactivez puis réactivez-la dans Accessibilité.
- Journal technique (sans le texte dicté) : `~/Library/Logs/Dictopen/` sur Mac, `%APPDATA%\Dictopen\logs` sur Windows.

Version 0.5.3 — octobre 2026. Mac : Apple Silicon et Intel ; Windows 10/11 64 bits.
