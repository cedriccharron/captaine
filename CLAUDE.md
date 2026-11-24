# Cap'taine — contexte pour Claude

Jeu de piste GPS par équipes pour familles et amis. Propriétaire : Cédric. Réponses et textes de l'app en français.

## Architecture (même que NosSoireesJeu)
- PWA en JavaScript sans compilation (modules ES), hébergée sur GitHub Pages ; routes dans le hash (`#/c/:id`, `#/g/:id/play`…).
- `js/app.js` : écrans en chaînes HTML, état global `S`, délégation d'événements (`data-action`).
- Deux stockages à interface identique : `js/store-demo.js` (navigateur, plusieurs « téléphones » simulés) et `js/store-supabase.js` (sessions anonymes, temps réel, file d'envoi hors ligne). `?demo` dans l'URL force le mode démo.
- Règles pures et testées : `js/game.js` (ordre, réponses, score, classement), `js/minigames.js` (détection secousse / niveau / cri), `js/geo.js`.
- Base : `supabase/schema.sql` (RLS, RPC `find_game`, `claim_team`, `take_over`, table `team_relay`, bucket `photos`). Projet Supabase : voir `js/config.js`.

## Décisions prises (voir le cahier des charges)
- Joueurs sans compte (session anonyme Supabase). Seuls les **administrateurs** créent parcours et parties : compte e-mail + mot de passe créé dans Supabase, e-mail listé dans `public.admins`, vérifié par la base (`is_admin()` dans les politiques RLS). Connexion dans l'onglet « Plus » ; `adopt_content` récupère les données de la session anonyme du téléphone. En démo, le téléphone principal est admin, les téléphones simulés non.
- Capitaine = premier téléphone qui prend une équipe libre ; « Passer le relais » par QR code.
- Le téléphone du capitaine fait foi (local d'abord) ; l'organisateur classe photos/vidéos (`judgments` : `{verdict, rank}` ou `"refused"`, ancien format `"done"` = tous les points).
- Points selon la performance (`js/game.js`) : énigme = vitesse (100 % sous 1 min, puis baisse jusqu'à 30 % au temps de référence `refMin`, chrono depuis l'arrivée) ; mini-jeu = proportionnel à l'objectif, meilleur de 2 essais ; photo/vidéo = place attribuée par le juge (100/80/60/50 %). Les points d'une étape sont un maximum.
- Ordre des étapes circulaire et décalé par équipe ; étape finale commune.
- Pas de réalité augmentée (Safari) ; l'écran du capitaine reste allumé (GPS web).

## Tests
- `node tests/logic.test.mjs`
- `tests/schema.test.mjs` (Postgres en mémoire : `npm i @electric-sql/pglite`)
- Navigateur : servir le dossier (`python3 -m http.server`) et ouvrir `/?demo#/`.

## Mise en ligne
Incrémenter `VERSION` dans `sw.js` à chaque déploiement, puis pousser sur `main` (GitHub Pages).

## Prochaines étapes
- Test terrain réel (GPS, boussole, hors ligne, relais) et corrections.
- Parcours réel du week-end familial de mai 2027.
- CAPTCHA anonyme avant ouverture à d'autres familles (il faudra alors aussi passer le jeton CAPTCHA à `signInWithPassword`).
