# Loup-Garou en ligne

Petite appli pour animer une partie de Loup-Garou : le Maître du Jeu (MJ) a
un écran de contrôle, chaque joueur a son rôle privé sur son téléphone.

## Rôles inclus (version simple)
- Loup-Garou
- Voyante
- Villageois

## Lancer en local (sur ton wifi, pour jouer entre vous)

1. Installe Node.js (https://nodejs.org) si ce n'est pas déjà fait.
2. Dans ce dossier :
   ```
   npm install
   npm start
   ```
3. Le serveur démarre sur http://localhost:3000
4. Sur ton ordinateur : ouvre http://localhost:3000/gm.html (écran du MJ).
5. Trouve l'adresse IP locale de ton ordi (ex: 192.168.1.23) :
   - Mac : `ipconfig getifaddr en0`
   - Windows : `ipconfig` (cherche "Adresse IPv4")
6. Chaque joueur, sur son téléphone connecté au **même wifi**, va sur :
   `http://192.168.1.23:3000/player.html` (remplace par ton IP).

## Jouer à distance (pas sur le même wifi)

Il faut héberger le serveur en ligne. Le plus simple et gratuit :
1. Crée un compte sur https://render.com (ou Railway, Fly.io...)
2. "New Web Service" → connecte ce dossier (via GitHub) ou upload direct
3. Build command : `npm install` — Start command : `npm start`
4. Une fois déployé, tu as une URL publique (ex: https://loup-garou-xxx.onrender.com)
5. MJ va sur `/gm.html`, joueurs vont sur `/player.html`, depuis n'importe où.

## Comment se déroule une partie

1. Le MJ crée une partie → un code à 4 lettres s'affiche.
2. Chaque joueur ouvre la page joueur, entre le code + son prénom.
3. Le MJ choisit le nombre de loups (et si la voyante est incluse) puis lance.
4. Chaque joueur voit son rôle en privé sur son téléphone.
5. Le MJ fait défiler les phases avec les boutons :
   - **Nuit — Loups** : les loups votent leur victime sur leur téléphone
   - **Nuit — Voyante** : la voyante consulte un rôle en privé
   - **Jour — Débat** : tout le monde discute à voix haute (pas d'action à l'écran)
   - **Jour — Vote** : tous les joueurs votent qui éliminer
6. Le MJ confirme les éliminations depuis son écran ; la partie se termine
   automatiquement quand un camp gagne.
