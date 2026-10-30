# Dictopen pour Chrome — corriger un courrier dans une page web

Dans un logiciel métier en ligne (Follow, Doctolib, messagerie, tout éditeur web), le bouton « Corriger » de Dictopen ne peut pas atteindre le texte caché dans les variables de l'éditeur. L'extension lit le courrier directement dans la page, le fait relire par Dictopen (votre clé API) et le remplace dans la page, variable par variable sur Follow.

## Installer (Chrome, Edge, Brave…)

1. Récupérez le dossier `extension` du dépôt (ou de l'archive de la version).
2. Ouvrez `chrome://extensions`, activez **Mode développeur** (en haut à droite), cliquez **Charger l'extension non empaquetée** et choisissez ce dossier.
3. Dans Dictopen → ⚙ Réglages → *Corriger la sélection*, vérifiez que **Extension « Dictopen pour Chrome »** est cochée (port 47395).

## Utiliser

- **Alt+Maj+C**, ou le bouton de l'extension, ou **Corriger** dans la barre Dictopen (quand le navigateur est au premier plan) : s'il y a une sélection elle est relue ; sinon l'extension reconnaît la page et choisit le texte :
  - **Follow** : le corps du courrier sans l'en-tête (formule d'appel et phrase de remerciement, qui portent l'identité du patient). Seules les réponses que vous avez tapées sont envoyées en correction ; le texte fixe du modèle et les réponses cochées ne bougent pas ; les cases vides et les paragraphes non remplis sont retirés.
  - **autres sites** : le champ de texte actif, sinon le plus grand éditeur visible de la page.
- Le panneau montre les différences (rouge = retiré, vert = ajouté) ; le texte est modifiable, un clic sur un passage barré le rétablit ; **Remplacer** écrit dans la page, **Copier** met le résultat dans le presse-papiers.
- Clic droit → **Diagnostic de la zone** : description anonymisée (lettres remplacées par x) de la structure de la page, utile pour adapter l'extension à un nouveau logiciel sans transmettre aucun texte.

## Ce qui est envoyé

Le texte à corriger va de l'extension à Dictopen (sur votre ordinateur, `127.0.0.1`), puis de Dictopen à OpenAI avec votre clé. Dictopen n'accepte ces demandes que depuis une extension de navigateur. L'option « Afficher le texte exact envoyé » du panneau permet de le vérifier.
