# PabloHFlix Console — démarrage rapide (UGOS Pro)

**Statut : code préparé et testé localement ; non installé sur le NAS à cette étape. Correctif Compose v0.1.1 pour UGOS (`env_file` absolu).**

1. Depuis **UGOS → Fichiers**, créer `/volume1/docker/nas-dashboard/` puis transférer tous les fichiers de l'archive en conservant `public/`, `metrics/`, `scripts/` et `compose.yaml`.
2. Créer dans UGOS le compte non administrateur `svc_console`, relever son UID/GID, lui donner la lecture du code et `metrics/`, sans accès à Media/Photos/Documents/moove. Le script planifié (à activer plus tard) devra appartenir à un administrateur et être non modifiable par ce compte.
3. Copier `.env.example` en `.env` et remplacer `user: "1000:100"` dans le Compose par l’UID:GID réels de `svc_console`. Remplir `PABLO_UID`, `PABLO_GID`, mot de passe unique (14 caractères minimum, recommandé 20+), `DASHBOARD_SESSION_SECRET` (64 caractères hex aléatoires). Pour générer la clé sur Mac : `openssl rand -hex 32`. **Ne transmettre ni `.env` ni les clés d'API dans le chat.**
4. Renseigner les clés Jellyfin, Radarr, Sonarr et Seerr si tu souhaites les statistiques dès le lancement. Les autres clés peuvent attendre.
5. Dans **UGOS → Docker → Projets**, créer **un nouveau projet** `nas-dashboard`, importer/coller `compose.yaml` du dossier. Vérifier que `media_services` et `jellyfin_default` sont présents sous Docker → Réseaux. Ne pas modifier les stacks existantes. Démarrer uniquement ce nouveau projet.
6. Sur ton Mac connecté au LAN, ouvrir **`http://192.168.1.200:3010`**. Une page de connexion doit apparaître. Vérifier la Console et changer de thème. Les intégrations sans clés affichent `—`, pas de fausses valeurs.
7. **Optionnel** : pour Docker, les deux volumes et les disques SMART, voir la section 3 du `README.md` pour installer la tâche UGOS qui appelle `scripts/collect-nas.sh` toutes les 5 min. Pas de montage du socket Docker et aucun changement iptables.
8. Après validation LAN, configurer dans NPM une route HTTPS privée (nom envisagé `console.pablohflix.duckdns.org:8443`) avec Pi-hole et la règle UGOS NPM→`3010` adaptée à la source actuelle, puis `COOKIE_SECURE=1`. Ne pas ouvrir de ports Internet/Freebox. Voir section 4 du `README.md`.

## Vérifications avant et après

- Avant : noter nombre de conteneurs et santé du NAS dans UGOS ; sauvegarder l'état Compose actuel si nécessaire.
- Après : le nouveau conteneur `pablohflix-console` doit être `healthy`, sans interruption de Jellyfin/Media-ARR/recordstudio.
- Tester : connexion, 4 thèmes, version mobile, Jellyfin et ARR, déconnexion, API inaccessible sans session.
- Retour arrière : arrêter/supprimer **le seul projet `nas-dashboard`** ; ne toucher à aucun volume ou réseau d'un autre projet. Conserver le dossier et `.env` en lieu sécurisé pour diagnostic.

Le guide complet, la matrice des données disponibles et les limites connues sont dans `README.md`.


**UGOS et variables :** si l’éditeur ne trouve pas `${DASHBOARD_PASSWORD}`, utiliser le `compose.yaml` corrigé v0.1.1 et lire `CORRECTIF_UGOS.md`. Le fichier `.env` est lu via `env_file: /volume1/docker/nas-dashboard/.env` et non plus par interpolation de variables dans le YAML.
