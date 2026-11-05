# Exemple historique avec chemins fictifs : adapter au NAS, ne pas copier sur une installation active.
# Patch v0.1.1 : correction UGOS `.env`

Le `compose.yaml` de la version 0.1.0 utilisait `${DASHBOARD_PASSWORD:?…}`.
L'éditeur de projets UGOS peut évaluer l'interpolation depuis un autre répertoire et ne pas trouver `.env`.

**Ce patch remplace les substitutions obligatoires par `env_file` avec un chemin absolu.**
La configuration du conteneur est lue directement dans `/volume1/docker/console-v1-example/.env`.

## À faire
1. Conserver ton `.env` actuel, le vérifier sur le NAS (ne pas me l'envoyer).
2. Remplacer uniquement le `compose.yaml` du projet `nas-dashboard` par ce nouveau fichier, y compris dans l'éditeur UGOS si tu avais collé le YAML.
3. **Modifier `user: "1000:100"` par l'UID:GID réels de `svc_console`** (ex. `"1234:100"`; valeur fictive). Cette ligne n'est plus calculée depuis `.env` pour ne pas dépendre de l'interpolation UGOS.
4. Dans UGOS → Docker → Projets → `nas-dashboard`, relancer uniquement ce projet.
5. Vérifier sur le NAS que `/volume1/docker/console-v1-example/.env` existe réellement, est lisible par l'outil Docker Compose, et contient `DASHBOARD_PASSWORD=` non vide et `DASHBOARD_SESSION_SECRET=` non vide.
6. Si problème de lecture du fichier : contrôler son chemin, sa casse, son nom exact et ses permissions ; ne pas coller les secrets dans le chat.

**Ne jamais supprimer ton `.env`, les dossiers `metrics/` ou les autres stacks.**

Les variables API (`JELLYFIN_API_KEY`, `RADARR_API_KEY`, etc.) sont maintenant prises directement depuis `.env`; elles ne sont plus écrasées par des valeurs vides dans `environment`.

### À propos de la sécurité

Le fichier `.env` reste un secret. Aucune valeur sensible n'est incluse dans cette archive.
Le mot de passe déjà envoyé dans une conversation devrait être changé avant la mise en service.
