# PabloHFlix Console Native v0.3 — Settings & cartes modulables

Dashboard privé pour **UGREEN DXP4800 Pro / UGOS Pro**, construit à partir du design natif V1. **Ce projet n'utilise plus Homarr.**

## Ce qui est nouveau en v0.3

- **Settings** (`/settings`) : navigation unique « Vue d'ensemble / Dashboard & cartes / Intégrations API / Catalogue de métriques / Apparence / Sauvegardes / Diagnostics ».
- **Cartes configurables** : conserver, créer, renommer, masquer, dupliquer, supprimer et réordonner les cartes (glisser-déposer ou ↑ ↓), configurer leur taille et leur lien.
- **Lignes configurables** : ajouter, modifier, supprimer, masquer, dupliquer et réordonner les indicateurs *à l'intérieur de n'importe quelle carte configurable*.
- **Multi-endpoints par intégration** : une seule connexion Jellyfin et une seule clé API, avec des lignes issues de `/Sessions` et `/Items/Counts`. Les lignes d'une même carte peuvent utiliser plusieurs applications.
- **Catalogue** : lectures en cours, utilisateurs actifs, transcodages, films, séries, épisodes Jellyfin ; statistiques Radarr, Sonarr, Seerr et Prowlarr.
- **Intégrations personnalisées REST JSON** : URL, clé API, auth Bearer/Basic/en-tête, endpoint GET, chemin JSON. Exploration des noms de champs renvoyés sans exposer leurs valeurs dans l'explorateur, test du compteur avant validation.
- **Persistance** : `data/dashboard.json` pour la disposition ; `data/integrations.json` pour les connecteurs et leurs clés chiffrées. Pas besoin de modifier le Compose pour chaque nouveau compteur.
- **Export/import JSON de disposition** (sans les clés API) et réinitialisation des cartes d'origine.
- **Thèmes V1** : Terminal Neon, Matrix, Midnight et Minimal Light, mémorisés dans le navigateur.
- **Compatibilité v0.2** : intégrations existantes conservées et anciens widgets numériques transformés en cartes au premier démarrage de v0.3.

### Exemple : films disponibles sur la carte Jellyfin

1. Ouvrir `http://192.168.1.200:3030/settings` puis **Dashboard & cartes**.
2. Sélectionner **JELLYFIN → Modifier → Ajouter une ligne**.
3. Choisir **Intégration API** puis la connexion **Jellyfin** existante.
4. Dans « Indicateur prédéfini », sélectionner **Films disponibles**. Cela préremplit `GET /Items/Counts`, champ `MovieCount`.
5. Cliquer **Tester la valeur**, puis **Enregistrer l'indicateur**.
6. Utiliser ↑ ↓ ou le glisser-déposer pour placer les films avant les utilisateurs actifs, par exemple.

Pour les séries : `SeriesCount`. Pour les épisodes : `EpisodeCount`. Une **seule intégration Jellyfin** suffit pour les trois.

### Éditeur d'indicateurs

- **Source interne** : mesure disponible dans `/api/status` (Jellyfin, media-arr, VPN, volumes NAS).
- **Source API** : choisir une intégration existante, puis un endpoint `GET` et un champ JSON. Pour une réponse de tableau, utiliser la transformation `Longueur du tableau` ou les transformations Jellyfin « Sessions en lecture », « Transcodages », « Utilisateurs en lecture ».
- **Formats** : valeur automatique, nombre, pourcentage, texte, Gio, durée. Suffixe facultatif.
- **Indisponibilité** : affiche `—` avec la raison en survol, sans inventer un zéro.

## Installation / mise à jour UGOS Pro

Le déploiement de référence est [`compose.preview.yaml`](compose.preview.yaml), accessible uniquement sur `192.168.1.200:3030` pour le LAN/Tailscale.

**Important :** l'utilisateur de conteneur confirmé est **UID 1005, GID 100**.

```bash
sudo mkdir -p /volume1/docker/pablohflix-native-preview/data
sudo chown -R 1005:100 /volume1/docker/pablohflix-native-preview/data
sudo chmod 750 /volume1/docker/pablohflix-native-preview/data
```

Créer `/volume1/docker/pablohflix-native-preview/.env` avec les paramètres de `.env.example` : `DASHBOARD_USER`, `DASHBOARD_PASSWORD` (≥14 caractères), `DASHBOARD_SESSION_SECRET` (≥32 caractères), `COOKIE_SECURE=0` pour l'HTTP LAN. Conserver **la clé de session déjà existante** à chaque mise à jour et assurer les permissions 600 sur ce fichier. En HTTPS derrière un proxy sécurisé, configurer `COOKIE_SECURE=1`.

**Mise à jour d'un conteneur v0.2 déjà fonctionnel :**

```bash
sudo docker pull ghcr.io/pabloohs/pablohflix-console:native-preview
```

Puis recréer/redéployer **uniquement** le projet `pablohflix-native-preview` depuis UGOS Docker, en conservant les volumes et les secrets. Le simple « redémarrer » ne recharge pas une image.

- Aucune action sur les conteneurs V1 `3010`, Homarr V2 `3020`, `recordstudio`, Jellyfin ou `media-arr`.
- Les réseaux externes `media_services` et `jellyfin_default` dans le Compose sont des **exemples à vérifier** via `docker network ls` et `docker inspect` avant un déploiement initial. Ne pas créer des réseaux vides portant ces noms. Utiliser les réseaux réellement partagés avec les services pour des URLs comme `http://jellyfin:8096`.
- Le volume `/volume1/docker/nas-dashboard/metrics` doit être disponible pour les métriques système héritées de V1 ; sinon supprimer temporairement ce montage, et accepter des indicateurs hôte indisponibles.

### Sauvegarde avant mise à jour

Sauvegarder **ensemble** :

1. `/volume1/docker/pablohflix-native-preview/data/`, contenant les intégrations chiffrées et la nouvelle disposition.
2. La valeur de `DASHBOARD_SESSION_SECRET` contenue dans `.env`, indispensable au déchiffrement des clés API.

L'export depuis l'onglet « Sauvegardes » ne contient **pas** les clés API et ne remplace pas une sauvegarde complète de `data/`.

### Vérification

```bash
sudo docker logs --tail 80 pablohflix-native-preview
curl -f http://192.168.1.200:3030/healthz
```

La route `/settings` est protégée par la même connexion administrateur que le dashboard. L'ancien lien `/integrations` redirige vers `/settings?tab=integrations`.

## Sécurité et limites

- Connexion par session HTTP-only, SameSite Strict ; les commandes de modification vérifient l'Origin du navigateur.
- Clés API chiffrées sur disque (AES-256-GCM) avec `DASHBOARD_SESSION_SECRET`, jamais renvoyées en clair par les endpoints de gestion.
- Les appels d'API sont effectués par le **backend** du dashboard, pas par le navigateur ; les destinations doivent être privées, les redirections sont interdites. Pas de socket Docker et pas d'accès Internet public exposé.
- La console utilise des intégrations **GET JSON en lecture seule** : pas d'actions destructives, de OAuth ou de websockets arbitraires. Les graphiques historiques et les permissions multi-comptes restent prévus pour plus tard.
- Les cartes à indicateurs Jellyfin / Media-arr / Recordstudio et les nouvelles cartes sont entièrement éditables. Les panneaux V1 spécialisés « Système », « Stockage », « Disques », « Actualité cyber », « Accès rapides » et « Réseau / VPN » conservent pour l'instant leurs présentations spécialisées : ils ne sont **pas encore** gérés ligne par ligne dans Settings.
- La configuration des endpoints est réservée à un administrateur de confiance sur le réseau privé ; pour une exposition sur Internet, un audit supplémentaire du réseau/API et une authentification plus forte seraient nécessaires.

## Développement / tests

Application Node 22 sans dépendances npm :

```bash
node --check server.mjs
node --check dashboard.mjs
node --check integrations.mjs
node --test tests/*.test.mjs
```

Architecture :
- `server.mjs` : API et authentification ; `integrations.mjs` : connecteurs, secrets et requêtes réseau.
- `dashboard.mjs` : disposition persistante, validation, templates et métriques.
- `public/dashboard-cards.js` : rendu des cartes depuis l'API, mode de réorganisation.
- `public/settings.html`, `public/settings.js`, `public/settings.css` : Settings complets.
- `public/index.html`, `public/style.css`, `public/app.js` : base visuelle V1 préservée.
- `tests/` : tests API, migration, multi-endpoints, métriques et sécurité.

### Archives de l'ancien fork Homarr

- `archive/homarr-upstream-dev-2026-11-03` : ancien `dev` Homarr.
- `archive/pablohflix-homarr-v2-2026-11-03` : ancienne adaptation Homarr PabloHFlix V2.
