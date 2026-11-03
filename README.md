# PabloHFlix Console — Native V1 + Intégrations Web

**Nouvelle architecture indépendante de Homarr.** Ce dépôt reconstruit la console NAS à partir de son interface V1.1, sans changer sa présentation visuelle. Il ajoute une page de gestion des intégrations et des widgets accessible depuis le navigateur.

## Utilisation sans SSH pour les intégrations

1. Ouvrir `http://ADRESSE_DU_NAS:PORT/integrations` après connexion au dashboard.
2. Cliquer sur **Ajouter** et choisir Jellyfin, Radarr, Sonarr, Seerr, Prowlarr, Bazarr, Recordstudio, Gluetun ou **Application personnalisée / REST JSON**.
3. Renseigner le nom, l'URL locale (ex. `http://jellyfin:8096`), la méthode d'authentification et le secret. Les champs avancés permettent de choisir un endpoint **GET JSON** et un champ JSON (ex. `data.total`, `sessions.length`).
4. Cliquer sur **Enregistrer et tester**. Les erreurs HTTP, de connexion ou d'authentification sont affichées directement dans l'interface.
5. Dans **Mes widgets**, sélectionner l'intégration, nommer la carte, puis cliquer **Ajouter au dashboard**. Les flèches permettent de réordonner les cartes.

La page principale `/` garde les modules de la V1 : système, disques, Jellyfin, media-arr, recordstudio, VPN, cyber, raccourcis. Les widgets créés via l'interface apparaissent à la fin du dashboard et sont actualisés toutes les 30 secondes.

## Sécurité

- Identifiants de session protégés par cookie `HttpOnly; SameSite=Strict` et mot de passe pour accéder à l'interface.
- Clés API/champs secrets chiffrés sur disque en **AES-256-GCM** avec une clé dérivée de `DASHBOARD_SESSION_SECRET` ; jamais renvoyés en clair aux navigateurs.
- URLs d'API limités aux hôtes privés et internes, ports explicites. Redirections HTTP refusées ; accès aux réseaux publics/loopback interdit.
- Configuration des intégrations conservée dans `DATA_DIR/integrations.json`, avec un volume persistant en Docker.
- **Conserver `DASHBOARD_SESSION_SECRET`** lors des redémarrages et mises à jour : la remplacer rend les anciens secrets illisibles.
- Ne pas exposer l'application sur Internet : accès LAN / Tailscale uniquement, conformément à l'architecture PabloHFlix.
- Aucun montage du socket Docker n'est nécessaire, pas de privilèges Docker.

## Tester sans toucher au NAS

```bash
node --test tests/*.test.mjs
DASHBOARD_USER=admin DASHBOARD_PASSWORD='un-mot-de-passe-fort-de-20-caracteres' DASHBOARD_SESSION_SECRET='cle-de-test-de-plus-de-32-caracteres' node server.mjs
```

L'application utilise les modules natifs Node.js, sans installation npm. Compatible Node 22.1+.

## Déploiement UGOS Pro séparé

Le fichier `compose.preview.yaml` est une proposition **de test**, port `3030`, indépendante de :

- la V1 sur `3010` ;
- Homarr V2 sur `3020` ;
- la stack `media-arr`, Jellyfin et `recordstudio`.

Copier les fichiers dans `/volume1/docker/pablohflix-native-preview`, créer `.env` à partir de `.env.example`, générer deux secrets forts distincts, créer le dossier `data` accessible par le compte UID du conteneur, puis créer le projet Docker via UGOS. Adapter les noms de réseaux partagés si nécessaire.

Les alias Docker internes (`http://jellyfin:8096`, `http://radarr:7878`, etc.) sont recommandés quand la console rejoint les réseaux correspondants, afin de **ne pas contourner le filtrage `UG_FORWARD`** par des règles globales. Vérifier les réseaux et leurs noms exacts avant déploiement. Pour les applications non sur un réseau partagé, autoriser uniquement les flux nécessaires dans les règles existantes.

## Structure

- `server.mjs` : session, API privée, métriques V1, fichiers statiques.
- `integrations.mjs` : catalogue, chiffrement des secrets, appels API, widgets et persistance.
- `public/index.html`, `public/style.css`, `public/app.js` : interface V1 préservée.
- `public/integrations.html`, `public/integrations.css`, `public/integrations.js` : configuration 100 % web.
- `public/widgets.js` : cartes personnalisées sur l'écran d'accueil.
- `tests/` : tests Node natifs.
- `scripts/collect-nas.sh` : collecte système existante.

## Limites actuelles

La première version personnalise les widgets **indicateur de valeur** et les appels **GET JSON**. Les graphiques multi-séries, plusieurs endpoints par connecteur, l'authentification OAuth, l'enregistrement de flux temps réel et le glisser-déposer libre ne sont pas encore développés. Les intégrations spécifiques non documentées peuvent nécessiter un connecteur dédié, tout en étant configurables ensuite depuis l'interface.

## Sauvegardes de l'ancien fork Homarr

- `archive/homarr-upstream-dev-2026-11-03` : ancien `dev` Homarr.
- `archive/pablohflix-homarr-v2-2026-11-03` : ancienne adaptation Homarr PabloHFlix V2.

Ces deux branches d'archive sont conservées. Le projet V1 natif ne réutilise pas le runtime de Homarr.
