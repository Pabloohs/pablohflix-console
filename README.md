# PabloHFlix Console — v0.4, configuration guidée

Dashboard privé UGREEN DXP4800 Pro / UGOS Pro, interface originale **PabloHFlix V1**, sans runtime Homarr. Cette version corrige la difficulté majeure signalée en v0.3 : **les indicateurs indisponibles doivent expliquer comment les activer**.

## Quoi de neuf en v0.4

- **Settings → Sources & configuration** : état réel par source (*connecté / à configurer / périmé / erreur / partiel*), cause probable, solutions et lien d'action. Les cartes Système, Stockage, SMART, Réseau, VPN et le bandeau renvoient vers ces diagnostics.
- **Settings → Flux RSS & groupes** : créer/renommer/réordonner/supprimer des groupes et des flux RSS/Atom HTTPS, activer/désactiver et tester chaque URL ; afficher les articles par catégorie, avec les erreurs explicites. Flux CERT-FR initial conservé. Lecture limitée à 700 Ko/flux, DNS épinglé et destinations privées refusées.
- **Settings → Accès rapides & groupes** : tous les liens de la V1 sont importés comme raccourcis modifiables. Ajouter, supprimer, renommer, regrouper et réordonner (flèches).
- **Settings → Indicateurs du bandeau** : jusqu'à quatre métriques choisies parmi Docker, VPN, alertes, stockage, sources disponibles et actualités.
- **Settings → Sources affichées** : choisir/réordonner les lignes « État des sources », y compris les nouvelles intégrations API personnalisées. Les sources personnalisées sélectionnées sont interrogées (statut joignable / erreur) avec mise en cache de 30 secondes.
- **Mesures de stockage automatiques** : statfs sur le petit dossier dédié du Volume 1 (`/app/data`) et du Volume 2 (`/app/volume2-probe`), sans parcourir les données utilisateurs, en lecture seule. Le collecteur hôte reste une alternative.
- **Intégrations Gluetun** : associer deux intégrations (Media / Recordstudio), configurer le pays attendu, lire statut/pays/IP par API depuis le web. Nécessite un contrôle Gluetun accessible depuis les réseaux Docker autorisés.
- **Pi-hole v6** : nouveau connecteur web ; utilise le mot de passe d'application pour créer une session FTL et lire les métriques. Pas de mot de passe en clair retourné au navigateur.
- **Onboarding** dans Settings → Vue d'ensemble, avec indicateurs « opérationnel / à configurer » ; export/import des groupes et préférences en plus de l'export des cartes.
- Les cartes et intégrations v0.3 restent compatibles. **Aucune migration destructive** : `data/dashboard.json`, `data/integrations.json` ne sont pas supprimés/modifiés par la nouvelle configuration.

## Après déploiement : parcours conseillé

1. Ouvrir `http://192.168.1.200:3030/settings` → **Sources & configuration**. Lire les états réels avant toute modification réseau.
2. **Stockage** : le Volume 1 doit apparaître automatiquement si `/app/data` est monté sur le Volume 1. Pour le Volume 2, suivre le montage du petit répertoire dédié ci-dessous.
3. **Docker / SMART** : activer le collecteur UGOS si l'état est « À configurer ». SMART ne peut pas être obtenu sans permissions depuis un conteneur applicatif non privilégié.
4. **Réseau & VPN** : connecter le service Gluetun via Intégrations API, puis attribuer la bonne intégration à Media / Recordstudio dans Sources & configuration. En cas de panne, utiliser « Tester » dans Intégrations API.
5. **Flux RSS & groupes** : tester CERT-FR ; vérifier que le NAS sort en HTTPS, puis ajouter d'autres flux dans des groupes dédiés.
6. **Accès rapides** : remplacer les URLs d'exemple par les vraies adresses de tes applications et créer des groupes.
7. **Bandeau / État des sources** : choisir les indicateurs à voir en haut, les sources et leur ordre. Ces réglages restent persistants.

## Mise à jour Docker UGOS (UID 1005 / GID 100)

Image : `ghcr.io/pabloohs/pablohflix-console:native-preview`. Projet `pablohflix-native-preview`, port **3030**, sans modifier V1 sur 3010, ni Homarr V2 sur 3020. Conserver exactement le même `.env`, notamment `DASHBOARD_SESSION_SECRET`, et le volume persistant `data`.

```bash
# Sauvegarde avant la mise à jour (le contenu contient des secrets chiffrés)
sudo tar -czf /volume1/docker/pablohflix-native-preview-backup-$(date +%Y%m%d).tgz -C /volume1/docker/pablohflix-native-preview data .env
# Dossier dédié pour lire l'espace du Volume 2, sans exposer les enregistrements
sudo mkdir -p /volume2/pablohflix-probe
# UID propriétaire du conteneur
sudo chown -R 1005:100 /volume1/docker/pablohflix-native-preview/data
# Télécharger l'image corrigée
sudo docker pull ghcr.io/pabloohs/pablohflix-console:native-preview
```

Dans le Compose UGOS, conserver les montages existants et ajouter uniquement :

```yaml
volumes:
  - /volume1/docker/pablohflix-native-preview/data:/app/data
  - /volume1/docker/nas-dashboard/metrics:/app/metrics:ro
  - /volume2/pablohflix-probe:/app/volume2-probe:ro
```

**Note** : ce fragment `volumes:` fait partie du service `console`, pas du niveau racine. Voir [`compose.preview.yaml`](compose.preview.yaml) pour le Compose complet. Les réseaux `media_services` et `jellyfin_default` restent **à vérifier** sur ton NAS avec `docker network ls` : ne les crée pas à l'aveugle. Après `docker pull`, **recréer** le conteneur via UGOS Docker, sans supprimer `data` ni `.env` ; un simple redémarrage conserve l'ancienne image.

Vérifier :

```bash
sudo docker ps --filter name=pablohflix-native-preview
sudo docker logs --tail 80 pablohflix-native-preview
curl -f http://192.168.1.200:3030/healthz
```

## Pourquoi Docker et SMART nécessitent un collecteur hôte

Nous refusons volontairement de monter `docker.sock` dans le dashboard : même en lecture seule, ce socket peut donner des privilèges dangereux. Les informations Docker / SMART doivent donc venir du **script local, en lecture seule** [`scripts/collect-nas.sh`](scripts/collect-nas.sh) :

1. Télécharger ou copier le script depuis ce dépôt après l'avoir examiné, puis le placer par exemple dans `/volume1/docker/pablohflix-native-preview/collect-nas.sh`.
2. Exécuter une fois en SSH avec les droits nécessaires : `sudo sh /volume1/docker/pablohflix-native-preview/collect-nas.sh`.
3. Vérifier le dossier `/volume1/docker/nas-dashboard/metrics` et en particulier `updated_at`, `docker.psv`, `volumes.df`, `disks.psv`.
4. Dans le planificateur de tâches UGOS, programmer l'exécution **chaque minute**. Le SMART est interrogé **au plus une fois par heure**, et `smartctl` doit être disponible sur l'hôte pour obtenir la santé/température.
5. Settings → Sources indique si le collecteur est absent, périmé ou actif. Le dossier de métriques est monté **en lecture seule** dans le conteneur.

Sans ce collecteur, les lignes Docker/SMART restent « À configurer » et non « 0 ». Le stockage peut néanmoins fonctionner via `statfs` avec les montages dédiés.

## Architecture / API

- `server.mjs` : API de statut, login, diagnostics, liens, RSS et bandeau.
- `preferences.mjs` : configuration persistante de l'expérience, validation des URLs et lecture RSS/Atom.
- `integrations.mjs` : connexions API et secrets chiffrés ; Pi-hole v6 avec session FTL.
- `dashboard.mjs` : cartes et lignes configurables, sources multi-endpoints.
- `public/preferences-settings.js` : formulaires Settings (RSS, liens, VPN, bandeau, ressources).
- `public/experience.js` : rendu du bandeau, RSS groupés, liens groupés et sources du dashboard.
- `scripts/collect-nas.sh` : métriques hôte expurgées et non privilégiées pour la console.

**Fichiers persistants** : `data/integrations.json` (secrets chiffrés), `data/dashboard.json` (cartes/lignes), `data/experience.json` (groupes RSS, raccourcis, indicateurs, source VPN). Tous doivent être sauvegardés avec la clé `DASHBOARD_SESSION_SECRET` dans `.env`. L'export JSON de l'interface ne contient **jamais** les secrets.

**Sécurité** : service disponible sur l'adresse LAN du NAS, LAN/Tailscale uniquement, sans port WAN. API réservée à la session administrateur. RSS : HTTPS seulement, refus des destinations privées, validation DNS et TLS, limite de réponse, délai et nombre de redirections. Raccourcis : liens HTTP(S) validés. Intégrations : secrets AES-256-GCM sur disque, pas de socket Docker. Actions modifiant l'état soumises à la vérification Origin.

## Qualité et limites

```bash
node --check server.mjs
node --check preferences.mjs
node --check public/preferences-settings.js
node --check public/experience.js
node --test tests/*.test.mjs
```

- Les règles réseau UGOS, la joignabilité réelle des conteneurs, la disponibilité de `smartctl` et la planification du collecteur doivent être validées **sur le NAS** ; le code ne peut pas les vérifier à distance.
- Les indicateurs du bandeau restent limités à six métriques prédéfinies (jusqu'à quatre affichées). Les panneaux matériels spécialisés Système/Stockage/Disques/VPN sont guidés et configurables par source, mais pas encore totalement composables ligne par ligne comme les cartes de services.
- Le RSS ne prend pas en charge les flux derrière authentification ; HTTPS RSS 2.0 et Atom standards sont pris en charge.
- L'interface web a été testée automatiquement côté API et modèle ; son rendu final doit être vérifié après déploiement sur UGOS et sur iPhone.

## Sauvegardes GitHub

- `archive/homarr-upstream-dev-2026-11-03` — Homarr amont.
- `archive/pablohflix-homarr-v2-2026-11-03` — ancienne adaptation Homarr.
- `archive/pablohflix-native-v0.2-before-settings-2026-11-04` — v0.2 native.
- `archive/pablohflix-native-v0.3-before-sources-2026-11-04` — v0.3 avant refonte des sources.

## Correctif RSS indépendant du statut NAS

Depuis le correctif du 4 novembre 2026, la page d'accueil lit les articles via `GET /api/rss` (session requise) indépendamment de `GET /api/status`. L'erreur du bandeau « Statut NAS indisponible » n'efface donc plus des articles déjà disponibles. Pour diagnostiquer une panne globale distincte, consulter `sudo docker logs --tail 100 pablohflix-native-preview` puis Settings → Sources. Les flux restent soumis au cache et aux contrôles HTTPS/DNS du lecteur RSS existant.
