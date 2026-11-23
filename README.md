# Cap'taine

Jeu de piste GPS par équipes, pour les familles et les amis. Application web installable (PWA), même architecture que NosSoireesJeu : JavaScript sans compilation, hébergement GitHub Pages, Supabase pour le mode en ligne.

## Ce que fait la version 0.2 (jalon 2)

- **Parcours** : création sur le terrain (« Ma position »), thèmes, étapes réordonnables, étape finale.
- **Partie solo** : une équipe, sur le téléphone de l'organisateur.
- **Partie à plusieurs équipes** (2 à 6) : salle d'attente avec code + QR code, chaque capitaine rejoint avec son téléphone et prend une équipe libre, sans créer de compte. Ordre des étapes décalé par équipe, niveau enfant ou ado/adulte par équipe.
- **Carte live de l'organisateur** : position des capitaines (pointillés si hors réseau depuis plus de 2 min), progression, validation des défis photo, messages et indices à une équipe ou à toutes, fin de partie.
- **Passer le relais** : le capitaine affiche un QR code ; le nouveau téléphone reprend la partie.
- **Hors ligne** : le téléphone du capitaine joue sans réseau ; progression, position et photos partent dès que le réseau revient.
- **Classement** : points acquis, égalité départagée par l'heure d'arrivée ; classement final après validation des photos.

## Mode démo (sans Supabase)

Si `js/config.js` est vide, tout reste dans le navigateur. Pour essayer à plusieurs équipes sur un seul appareil : lance une partie à 2 équipes, puis « Simuler le téléphone d'un capitaine » dans la salle d'attente (ou ouvre plusieurs onglets).

## Brancher Supabase

1. Crée un projet sur supabase.com (région Europe).
2. *Authentication > Sign In / Providers* : active **Allow anonymous sign-ins**.
3. *SQL Editor > New query* : colle le contenu de `supabase/schema.sql`, puis **Run**. Le script peut être relancé sans danger.
4. *Project Settings > API* : copie l'URL du projet et la clé **anon / publishable** dans `js/config.js`.
5. Avant d'ouvrir l'app à d'autres familles : activer un CAPTCHA (*Authentication > Attack Protection*) pour éviter les abus de comptes anonymes.

## Mettre en ligne (GitHub Pages)

1. Crée un dépôt GitHub (ex. `captaine`) et dépose-y le contenu de ce dossier.
2. *Settings > Pages* : « Deploy from a branch », branche `main`, dossier `/ (root)`.
3. Ouvre `https://<ton-compte>.github.io/captaine/` sur l'iPhone, dans Safari, puis Partager > « Sur l'écran d'accueil ».

Le GPS, la boussole et le mode hors ligne exigent une adresse en https : ils ne fonctionnent pas dans l'aperçu publié sur claude.ai (simulation seulement, en mode démo).

À chaque mise en ligne, incrémente `VERSION` dans `sw.js` pour que les téléphones récupèrent la nouvelle version.

## Structure

| Fichier | Rôle |
| --- | --- |
| `index.html`, `manifest.webmanifest`, `sw.js` | Coquille de l'app, installation, hors ligne |
| `js/app.js` | Navigation, écrans, actions |
| `js/game.js` | Règles : ordre des étapes, réponses, score, classement (sans interface, testé) |
| `js/geo.js` | Distance, cap, GPS, boussole, écran allumé |
| `js/themes.js` | Thèmes : couleurs et vocabulaire |
| `js/store-demo.js` | Mode démo (navigateur) + parcours d'exemple |
| `js/store-supabase.js` | Mode en ligne : sessions anonymes, temps réel, file d'envoi hors ligne, photos |
| `js/config.js` | Clés Supabase (vides = mode démo) |
| `js/vendor/` | supabase-js et qrcode-generator (licence MIT), embarqués pour fonctionner hors ligne |
| `supabase/schema.sql` | Tables, sécurité (RLS), fonctions, temps réel, stockage des photos |
| `tests/` | `node tests/logic.test.mjs` ; `tests/schema.test.mjs` (Postgres en mémoire, `npm i @electric-sql/pglite`) |

## Sécurité (résumé)

- Un téléphone qui n'est ni organisateur ni capitaine d'une partie ne voit rien de cette partie.
- Un capitaine ne modifie que la progression et la position de son équipe ; la validation des photos est réservée à l'organisateur.
- Le code de relais n'est lisible que par le capitaine de l'équipe et ne sert qu'une fois.
- Les photos sont dans un espace privé, visibles seulement par les joueurs de la partie.

## Limites connues (iPhone, app web)

- Le GPS ne fonctionne que si l'app est affichée : le capitaine garde l'écran allumé (l'app le demande au téléphone).
- La boussole demande une autorisation à chaque lancement (bouton « Activer la boussole »).
- Pas de réalité augmentée (Safari ne la permet pas dans une page web).
- Lors d'un relais, ce que l'ancien téléphone n'avait pas encore envoyé faute de réseau est perdu.
