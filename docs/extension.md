# Dictopen pour Chrome — corriger un courrier dans une page web

Dans un logiciel métier en ligne (Follow, Doctolib, messagerie, tout éditeur web), le bouton « Corriger » de Dictopen ne peut pas atteindre le texte caché dans les variables de l'éditeur. L'extension lit le courrier directement dans la page, le fait relire par Dictopen (votre clé API) et le remplace dans la page, variable par variable sur Follow.

## Installer (Chrome, Edge, Brave…)

1. Dictopen → ⚙ Réglages → *Corriger la sélection* → **Installer « Dictopen pour Chrome »…** : le dossier de l'extension est préparé et montré (avec un fichier `config.js` qui porte le jeton de liaison), la page des extensions s'ouvre.
2. Dans `chrome://extensions`, activez **Mode développeur** (en haut à droite), cliquez **Charger l'extension non empaquetée** et choisissez ce dossier.
3. Si vous chargez plutôt le dossier `extension` du dépôt (sans `config.js`) : copiez le **jeton de l'extension** depuis Dictopen → ⚙ Réglages → *Corriger la sélection* et collez-le dans les options de l'extension (clic droit sur son icône → Options). Après « Régénérer » dans Dictopen, recliquez « Installer » (ou recollez le jeton) puis ↻ sur l'extension.

## Utiliser

- **Alt+Maj+C**, ou le bouton de l'extension, ou **Corriger** dans la barre Dictopen (quand le navigateur est au premier plan) : s'il y a une sélection elle est relue ; sinon l'extension reconnaît la page et choisit le texte :
  - **Follow** : le corps du courrier sans l'en-tête (formule d'appel et phrase de remerciement, qui portent l'identité du patient). Seules les réponses que vous avez tapées sont envoyées en correction ; le texte fixe du modèle et les réponses cochées ne bougent pas ; les cases vides et les paragraphes non remplis sont retirés.
  - **autres sites** : le champ de texte actif, sinon le plus grand éditeur visible de la page. Comme ce texte n'a pas été choisi par vous, le panneau le montre d'abord (identifiants masqués) avec un bouton **Envoyer en correction** ; l'option « Toujours envoyer sans cette vérification » des options de l'extension supprime cette étape, à vos risques (avertissement affiché).
- **Masquage des identifiants** : avant tout envoi, les noms qui suivent une civilité (Madame, M., Dr…), les dates de naissance, les numéros de sécurité sociale, téléphones, courriels et adresses postales sont remplacés par des marqueurs `[ID1]`, `[ID2]`… que le modèle recopie et que l'extension restitue. Heuristique : un prénom seul ou un nom sans civilité ne sont pas reconnus.
- Le panneau montre les différences (rouge = retiré, vert = ajouté) ; le texte est modifiable, un clic sur un passage barré le rétablit ; **Remplacer** écrit dans la page, **Copier** met le résultat dans le presse-papiers.
- Clic droit → **Diagnostic de la zone** : description anonymisée (lettres remplacées par x) de la structure de la page, utile pour adapter l'extension à un nouveau logiciel sans transmettre aucun texte.

## Ce qui est envoyé

Le texte à corriger va de l'extension à Dictopen (sur votre ordinateur, `127.0.0.1`), puis de Dictopen au modèle choisi (OpenAI, ou Anthropic / Claude Code selon le réglage) avec votre clé. Dictopen n'accepte ces demandes que depuis une extension de navigateur **qui présente le jeton de liaison** (un autre programme du poste ne peut donc pas utiliser votre clé), et l'extension exige en retour que Dictopen prouve qu'il connaît ce jeton avant de lui envoyer le moindre texte (un autre programme ne peut pas se faire passer pour Dictopen en occupant le port). L'option « Afficher le texte exact envoyé » du panneau permet de vérifier ce qui part (identifiants déjà masqués). Sur Follow, l'en-tête n'est jamais capturé et seules les réponses tapées sont transmises ; ailleurs, c'est votre sélection ou le champ montré avant envoi. Aucune de ces mesures n'est infaillible : relisez ce qui part quand le texte n'est pas de vous.
