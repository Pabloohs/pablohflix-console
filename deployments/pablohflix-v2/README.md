# PabloHFlix V2 — pré-déploiement UGOS Pro

Cette configuration lance une **instance distincte** du prototype `nas-dashboard` actuel.
**Ne l'installez pas avant que l'image GHCR `v2-preview` existe et soit vérifiée.**

## Préparation

- Fichier Compose : `compose.yaml` de ce dossier.
- L'image est compilée automatiquement par `.github/workflows/pablohflix-preview-image.yml` sur GitHub Actions.
- En local uniquement, créer un fichier `.env` à côté du Compose et y définir `SECRET_ENCRYPTION_KEY` à une valeur hexadécimale de 64 caractères (`openssl rand -hex 32`). Ne jamais commiter la clé.
- Vérifier que l'image est téléchargeable : sa publication GHCR peut être privée et nécessiter une connexion au registre.

## Accès prévu

- Console : `http://192.168.1.200:3020/console` après installation et configuration de Homarr.
- Administration Homarr : `http://192.168.1.200:3020/manage`.
- La publication Docker est liée seulement à l'adresse LAN `192.168.1.200`. L'accès distant via Tailscale nécessite une route privée vers ce LAN ou un proxy privé dédié ; ce Compose **n'ouvre pas de port Tailscale directement**.
- Aucun port WAN Freebox ne doit être ouvert.

## Isolation et sécurité

- Projet Docker `pablohflix-v2` distinct des stacks Jellyfin, media-arr, recordstudio, DNS et du prototype V1.
- Aucun montage `/var/run/docker.sock` ni élévation `privileged`.
- L'intégration Docker de Homarr est donc désactivée. La supervision des conteneurs demandera plus tard un collecteur borné.
- Les données de la V2 restent dans le volume Docker nommé `pablohflix_v2_appdata`.
- PUID 1005 / PGID 100 correspondent au compte de service prévu ; l'entrée du conteneur adapte les permissions des répertoires internes nécessaires.
- Aucun mot de passe, jeton ou clé API ne doit être ajouté aux fichiers GitHub.
- Pour intégrations Jellyfin/arr, l'accès depuis ce réseau privé vers les API LAN doit être vérifié. Ne pas rejoindre les réseaux Docker existants sans examen.

## Avant mise en production

1. Attendre une image GHCR disponible et une CI réussie sur le commit associé.
2. Vérifier depuis le NAS les paramètres réseau et droits du compte de service.
3. Installer comme nouveau projet Docker sous UGOS Pro, sans remplacer V1.
4. Tester `/console`, `/manage`, les thèmes, le login et la persistance après redémarrage du conteneur.
5. Mesurer consommation RAM/CPU, puis vérifier les intégrations depuis le réseau de la V2.

Le dépôt amont Homarr reste sous licence Apache 2.0 et ses mentions légales doivent être conservées.
