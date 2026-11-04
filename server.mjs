import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createIntegrationStore, PRESETS, jellyfinAuthHeaders } from './integrations.mjs';
import { createDashboardStore, METRIC_TEMPLATES } from './dashboard.mjs';
import {createPreferenceStore, createFeedReader, OVERVIEW_METRICS} from './preferences.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || '3000');
const USER = process.env.DASHBOARD_USER || 'admin';
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || '';
const METRICS = process.env.METRICS_DIR || path.join(ROOT, 'metrics');
const TEST = process.env.NODE_ENV === 'test';
if (!TEST && (PASSWORD.length < 14 || SESSION_SECRET.length < 32)) {
  console.error('Configuration refusée : définir DASHBOARD_PASSWORD (>=14 caractères) et DASHBOARD_SESSION_SECRET (>=32 caractères).');
  process.exit(1);
}
const sessions = new Map();
const failures = new Map();
const caches = new Map();
const resourceHealthCache = new Map();
const DATA = process.env.DATA_DIR||path.join(ROOT,'data');
const store = createIntegrationStore({dir:DATA,secret:SESSION_SECRET||'testing-integration-secret-00000000000000000000'});
const preferences = createPreferenceStore({dir:DATA});
const feedReader = createFeedReader({preferences});
const dashboard = createDashboardStore({dir:DATA,integrations:store});
let previousCpu = null;

function json(res, code, body, extras={}) {
  res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...extras });
  res.end(JSON.stringify(body));
}
function safeEqual(a, b) {
  const x=crypto.createHash('sha256').update(a).digest();
  const y=crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x,y);
}
function hashToken(token) { return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex'); }
function cookies(req) { return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=').slice(0,2)).filter(x=>x.length===2)); }
function authorized(req) {
  const token=cookies(req).pablo_session;
  if (!token) return false;
  const info=sessions.get(hashToken(token));
  if (!info || info<Date.now()) return false;
  return true;
}
function sameOrigin(req) {
  const origin=req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function isSecure(req) { return process.env.COOKIE_SECURE==='1' || String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https'; }
function cookie(req, value, maxAge=0) { return `pablo_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isSecure(req)?'; Secure':''}`; }
async function readBody(req, limit=4096) {
  let size=0, parts=[];
  for await (const buf of req) { size+=buf.length; if(size>limit) throw Error('body too large'); parts.push(buf); }
  return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');
}
function localFile(name) {
  try { return fs.readFileSync(path.join(METRICS,name),'utf8'); } catch { return null; }
}
function number(value) { const n=Number(value); return Number.isFinite(n)?n:null; }
function formatState(value) { return /^[\w.-]{1,32}$/.test(value||'')?value:'unknown'; }
function collectHost() {
  let cpu=null;
  const snapshot=os.cpus().reduce((acc,c)=>{acc.total+=Object.values(c.times).reduce((a,b)=>a+b,0);acc.idle+=c.times.idle;return acc;},{total:0,idle:0});
  if(previousCpu && snapshot.total>previousCpu.total) cpu=Math.max(0,Math.min(100,Math.round(100*(1-(snapshot.idle-previousCpu.idle)/(snapshot.total-previousCpu.total)))));
  previousCpu=snapshot;
  const memTotal=os.totalmem(),memFree=os.freemem();
  return {cpu,ram: memTotal?Math.round(100*(1-memFree/memTotal)):null,ramBytes:memTotal,uptimeSeconds:Math.floor(os.uptime()), note:'Mesures via les API système Node.js : charge CPU, mémoire et uptime'};
}
function mountedVolumeStats(mount) {
  // statfs is a read-only syscall. The bind mount is a tiny empty directory on the respective volume,
  // not the user's library contents. This cannot reveal disks' SMART health.
  try {
    if(!fs.existsSync(mount))return null;
    const info=fs.statfsSync(mount,{bigint:true});
    const totalBytes=Number(info.blocks*info.bsize);
    const freeBytes=Number(info.bavail*info.bsize);
    if(!Number.isFinite(totalBytes)||totalBytes<=0||!Number.isFinite(freeBytes))return null;
    const usedPercent=Math.max(0,Math.min(100,Math.round(100*(1-freeBytes/totalBytes))));
    return {totalBytes,freeBytes,usedPercent,freePercent:100-usedPercent,method:'statfs'};
  }catch{return null;}
}
// Filter out RAM-backed and virtual block devices from existing SMART inventories.
function parseSmartDisks(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [device, model, size, health, temp] = line.split('|');
    const name = String(device || '').trim();
    if (!/^[a-z0-9._-]{1,32}$/i.test(name) ||
        /^(?:zram|ram\d+|loop\d+|nbd\d+|md\d+|dm-\d+|sr\d+)/i.test(name)) return null;
    return {
      device: name, model: (model || '').slice(0, 120),
      size: (size || '').slice(0, 22),
      health: ['PASSED','FAILED','UNKNOWN'].includes(health) ? health : 'UNKNOWN',
      tempC: /^\d+$/.test(temp || '') ? number(temp) : null
    };
  }).filter(Boolean);
}

function collectSnapshot() {
  const raw=localFile('docker.psv');
  const probeAt=(localFile('updated_at')||'').trim()||null;
  const fresh=probeAt && Number.isFinite(Date.parse(probeAt)) && Math.abs(Date.now()-Date.parse(probeAt))<15*60*1000;
  let docker={ok:false,up:null,down:null,total:null,unhealthy:null,containers:[],updatedAt:null};
  if(raw!==null && fresh) {
    const lines=raw.trim().split(/\r?\n/).filter(Boolean);
    const containers=lines.map(line=>{
      const [name,state,status]=line.split('|');
      return {name:(name||'').slice(0,70),state:formatState(state),health:/\bunhealthy\b/i.test(status||'')?'unhealthy':/\bhealthy\b/i.test(status||'')?'healthy':null};
    }).filter(x=>x.name);
    const up=containers.filter(x=>x.state==='running').length;
    docker={ok:true,total:containers.length,up,down:containers.length-up,unhealthy:containers.filter(x=>x.health==='unhealthy').length,containers:containers.map(({name,state,health})=>({name,state,health})),updatedAt:(localFile('updated_at')||'').trim()||null};
  }
  const df=fresh?localFile('volumes.df'):null;
  const volumes={volume1:null,volume2:null};
  if(df) {
    for(const line of df.trim().split(/\r?\n/).slice(1)) {
      const fields=line.trim().split(/\s+/);
      if(fields.length<6) continue;
      const p=fields.at(-1), blocks=number(fields[1]),available=number(fields[3]);
      if(!blocks || available===null) continue;
      const metric={totalBytes:blocks*1024,freeBytes:available*1024,usedPercent:Math.round(100*(1-available/blocks)),freePercent:Math.round(100*available/blocks)};
      if(p==='/volume1') volumes.volume1=metric;
      if(p==='/volume2') volumes.volume2=metric;
    }
  }
  // Volume capacity works without a host-side scheduled task when read-only probe mounts exist.
  if(!volumes.volume1)volumes.volume1=mountedVolumeStats(process.env.HOST_VOLUME1_PATH||'/app/data');
  if(!volumes.volume2)volumes.volume2=mountedVolumeStats(process.env.HOST_VOLUME2_PATH||'/app/volume2-probe');
  const disksRaw=fresh?localFile('disks.psv'):null;
  const disks=parseSmartDisks(disksRaw);
  return {docker,volumes,disks,probeAt,probeFresh:Boolean(fresh),collectorPresent:raw!==null,metricsDir:METRICS};
}
async function fetchJson(url, headers={}, timeout=4200, extra={}) {
  if(!url) return null;
  const u=new URL(url);
  if(!['http:','https:'].includes(u.protocol)) throw Error('unsupported URL');
  const r=await fetch(url,{signal:AbortSignal.timeout(timeout),headers, ...extra});
  if(!r.ok) throw Error(`HTTP ${r.status}`);
  return r.json();
}
async function cached(name,ttl,fn) {
  const item=caches.get(name); if(item && Date.now()-item.time<ttl) return item.data;
  try {const data=await fn(); caches.set(name,{time:Date.now(),data});return data;} catch {return null;}
}
const endpoint=(env,fallback)=>String(process.env[env]||fallback||'').replace(/\/$/,'');
async function jellyfin(){
  const custom=store.getInternalForType('jellyfin');const url=custom?.url||endpoint('JELLYFIN_URL','http://jellyfin:8096');const key=custom?.apiKey||process.env.JELLYFIN_API_KEY;
  if(!key)return {ok:false,reason:'Clé API non configurée',streams:null,transcodes:null,users:null};
  const sessions=await fetchJson(`${url}/Sessions`,jellyfinAuthHeaders(key));
  const active=(Array.isArray(sessions)?sessions:[]).filter(s=>Boolean(s.NowPlayingItem));
  return {ok:true,streams:active.length,transcodes:active.filter(s=>Boolean(s.TranscodingInfo) || s.PlayState?.PlayMethod==='Transcode').length,users:new Set(active.map(s=>s.UserId).filter(Boolean)).size};
}
async function arr(name,defaultUrl){
  const custom=store.getInternalForType(name.toLowerCase());const url=custom?.url||endpoint(name+'_URL',defaultUrl),key=custom?.apiKey||process.env[name+'_API_KEY'];
  if(!key)return {ok:false,reason:'Clé API non configurée',missing:null,queue:null};
  const headers={'X-Api-Key':key};
  const [missing,queue]=await Promise.all([
    fetchJson(`${url}/api/v3/wanted/missing?page=1&pageSize=1`,headers),
    fetchJson(`${url}/api/v3/queue?page=1&pageSize=1`,headers)
  ]);
  return {ok:true,missing:number(missing.totalRecords),queue:number(queue.totalRecords)};
}
async function seerr(){
  const custom=store.getInternalForType('seerr');const key=custom?.apiKey||process.env.SEERR_API_KEY;
  if(!key)return {ok:false,pending:null,reason:'Clé API non configurée'};
  const data=await fetchJson(`${custom?.url||endpoint('SEERR_URL','http://seerr:5055')}/api/v1/request/count`,{'X-Api-Key':key});
  return {ok:true,pending:number(data.pending),total:number(data.total)};
}
async function pihole(){
  const configured=store.list().find(x=>x.type==='pihole');
  if(configured){
    try {
      const data=await store.queryData(configured.id,'/api/stats/summary');
      return {ok:true,queries:number(data.queries?.total),blockedPercent:number(data.queries?.percent_blocked)};
    }catch(e){return {ok:false,reason:String(e.message||'API Pi-hole inaccessible').slice(0,130),queries:null,blockedPercent:null};}
  }
  const url=endpoint('PIHOLE_URL','');
  if(!url)return {ok:false,reason:'Pi-hole non configuré dans Intégrations API',queries:null,blockedPercent:null};
  const password=process.env.PIHOLE_APP_PASSWORD;
  let headers={};
  if(password){
    const auth=await fetchJson(url+'/api/auth',{'Content-Type':'application/json'},4200,{method:'POST',body:JSON.stringify({password})});
    const sid=auth?.session?.sid;
    if(!sid) throw Error('Pi-hole auth failed');
    headers['X-FTL-SID']=sid;
  }
  const data=await fetchJson(url+'/api/stats/summary',headers);
  return {ok:true,queries:number(data.queries?.total),blockedPercent:number(data.queries?.percent_blocked)};
}
async function vpn(prefix){
  const pref=preferences.read().vpns[prefix==='VPN_MEDIA'?'media':'record'];
  if(pref?.integrationId){
    if(!store.list().some(x=>x.id===pref.integrationId))return {ok:false,reason:'Intégration VPN supprimée',configured:false,state:'unknown'};
    try{
      const [result,publicIp]=await Promise.all([
        store.queryData(pref.integrationId,'/v1/vpn/status'),
        store.queryData(pref.integrationId,'/v1/publicip/ip'),
      ]);
      const country=publicIp.country_code||publicIp.country||null;
      return {ok:true,state:result.status||'unknown',ip:publicIp.public_ip||null,country,expected:pref.expectedCountry||null,match:pref.expectedCountry&&country?country.toUpperCase()===pref.expectedCountry:null,configured:true};
    }catch(e){return {ok:false,reason:String(e.message||'API VPN inaccessible').slice(0,140),configured:true,state:'unknown'};}
  }
  const url=endpoint(prefix+'_URL','');
  if(!url)return {ok:false,reason:'VPN non configuré dans Settings',configured:false,state:'unknown',ip:null,country:null};
  const key=process.env[prefix+'_API_KEY'];
  const headers=key?{'X-API-Key':key}:{};
  const [result,publicIp]=await Promise.all([
    fetchJson(url+'/v1/vpn/status',headers),fetchJson(url+'/v1/publicip/ip',headers)
  ]);
  const expected=process.env[prefix+'_EXPECTED_COUNTRY']||null;
  const country=publicIp.country_code||publicIp.country||null;
  const match=expected&&country?String(country).toLowerCase()===expected.toLowerCase():null;
  return {ok:true,state:result.status||'unknown',ip:publicIp.public_ip||null,country,expected,match,configured:true};
}

function decodeXml(s){return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();}
async function status(){
  const [j,r,s,requests,dns,mediaVpn,recVpn,rss]=await Promise.all([
    cached('jellyfin',20000,jellyfin),cached('radarr',30000,()=>arr('RADARR','http://radarr:7878')),
    cached('sonarr',30000,()=>arr('SONARR','http://sonarr:8989')),
    cached('seerr',30000,seerr),cached('pihole',60000,pihole),
    cached('vpnmedia',20000,()=>vpn('VPN_MEDIA')),cached('vpnrecord',20000,()=>vpn('VPN_RECORD')),
    feedReader.read()
  ]);
  const snapshot=collectSnapshot();
  const results={jellyfin:j,radarr:r,sonarr:s,seerr:requests,pihole:dns,vpnMedia:mediaVpn,vpnRecord:recVpn};
  const configured=Object.values(results).filter(x=>x?.ok===true).length;
  return {timestamp:new Date().toISOString(),system:collectHost(),...snapshot,...results,
    news:rss.items.slice(0,16),rss,experience:preferences.read(),integrations:{responsive:configured,total:7}};
}
async function diagnosticStatus(snapshot){
  const config=preferences.read();
  const result=[];
  const add=(id,label,kind,summary,steps,tab='sources')=>result.push({id,label,kind,summary,steps,tab});
  add('api','API & connexion','ready','La console répond. Tu es connecté au serveur.',[], 'sources');
  if(snapshot.docker?.ok) add('docker','Conteneurs Docker','ready',`${snapshot.docker.up} actifs sur ${snapshot.docker.total}`,[]);
  else add('docker','Conteneurs Docker',snapshot.collectorPresent?'stale':'missing','Aucun inventaire Docker récent. Les indicateurs —/— ne signifient pas zéro conteneur.',[
    'Installer le collecteur hôte depuis le guide ci-dessous, puis le planifier chaque minute dans UGOS.',
    `Le collecteur doit écrire dans ${METRICS}, monté en lecture seule dans la console.`,
    'Ne monte pas /var/run/docker.sock dans la console : cela donnerait des privilèges excessifs.'
  ]);
  for(const [name,label] of [['volume1','Volume 1 (RAID5)'],['volume2','Volume 2']]){
    const v=snapshot.volumes?.[name];
    if(v)add(name,label,'ready',`${v.usedPercent}% occupés · ${v.method||'collecteur NAS'}`,[]);
    else add(name,label,'missing',name==='volume2'?'Point de mesure du Volume 2 absent.':'Point de mesure Volume 1 absent.',[
      name==='volume2'?'Créer /volume2/pablohflix-probe puis monter ce dossier en lecture seule vers /app/volume2-probe dans le Compose.':'Vérifier que le volume persistant /app/data est bien monté et accessible.',
      'Alternative : activer le collecteur hôte pour récupérer les données df des volumes.'
    ]);
  }
  if(snapshot.disks?.length){
    const unknown=snapshot.disks.filter(d=>d.health==='UNKNOWN').length;
    add('smart','Disques & SMART',unknown?'partial':'ready',`${snapshot.disks.length} disques inventoriés${unknown?' · '+unknown+' sans statut SMART':''}`,unknown?['Le collecteur voit les disques, mais smartctl n’est pas disponible ou ne peut pas lire certains attributs. Vérifier smartctl et les permissions sur l’hôte.']:[]);
  }else add('smart','Disques & SMART','missing','Aucun inventaire SMART exploitable.',[
    'SMART nécessite une interrogation depuis UGOS/hôte, pas depuis un conteneur sans privilèges.',
    'Installer et planifier le collecteur hôte, puis contrôler que smartctl et lsblk sont disponibles.'
  ]);
  for(const [name,label,key] of [['jellyfin','Jellyfin','jellyfin'],['radarr','Radarr','radarr'],['sonarr','Sonarr','sonarr'],['seerr','Seerr','seerr']]){
    const value=snapshot[key];
    const configured=store.list().some(x=>x.type===name);
    add(name,label,value?.ok?'ready':configured?'error':'missing',value?.ok?'API joignable.':configured?'L’API ne répond pas ou refuse les identifiants.':'Aucune intégration configurée.',[value?.ok?'':configured?'Dans Intégrations, utiliser « Tester » pour obtenir le code HTTP ou la cause réseau.':'Dans Intégrations API, ajouter le service avec son URL Docker et sa clé API.'].filter(Boolean),'integrations');
  }
  for(const [id,label,value,key] of [['vpnmedia','VPN Media',snapshot.vpnMedia,'media'],['vpnrecord','VPN Recordstudio',snapshot.vpnRecord,'record']]){
    add(id,label,value?.ok?'ready':value?.configured?'error':'missing',value?.ok?`${value.state||'inconnu'} · ${value.country||'pays non connu'}`:value?.reason||'VPN non configuré.',value?.ok?[]:['Créer une intégration Gluetun dans Intégrations API.',`Dans Settings → Sources, attribuer l’intégration au profil VPN ${key}.`,value?.reason||'Vérifier le contrôle Gluetun et son authentification.'],'sources');
  }
  const feedIssues=snapshot.rss?.feeds?.filter(x=>!x.ok)||[];
  add('rss','Actualité cyber / RSS',!config.feeds.some(f=>f.enabled)?'missing':feedIssues.length?'error':'ready',!config.feeds.some(f=>f.enabled)?'Aucun flux activé.':feedIssues.length?`${feedIssues.length} flux en erreur · ${feedIssues.map(x=>x.name+': '+x.reason).join(' | ').slice(0,220)}`:`${snapshot.rss.feeds.length} flux accessibles · ${snapshot.news.length} articles`,feedIssues.length?['Vérifier URL, DNS et HTTPS dans Settings → Flux RSS.','Le NAS doit pouvoir sortir en HTTPS (port 443). Aucun RSS ne requiert l’accès au LAN.']:[],'feeds');
  add('pihole','Pi-hole',snapshot.pihole?.ok?'ready':store.list().some(x=>x.type==='pihole')?'error':'missing',snapshot.pihole?.ok?'API connectée':snapshot.pihole?.reason||'Pi-hole non configuré.',snapshot.pihole?.ok?[]:['Dans Intégrations API, ajouter « Pi-hole v6 », son URL interne et son mot de passe d’application (clé API du formulaire).','Tester la connexion, puis vérifier son accès réseau depuis le conteneur.'],'integrations');
  // User-selected custom integrations are probed for actual API availability. Others remain untested.
  const managed=store.list().filter(x=>!['jellyfin','radarr','sonarr','seerr'].includes(x.type));
  const chosen=new Set(config.resourceSources||[]);
  const toCheck=managed.filter(x=>chosen.has('api-'+x.id)).slice(0,12);
  const results=new Map();
  await Promise.all(toCheck.map(async item=>{
    const cached=resourceHealthCache.get(item.id);
    if(cached && Date.now()-cached.at<30000){results.set(item.id,cached.value);return;}
    let value;
    try{value=await store.test(item.id);}catch(e){value={ok:false,reason:String(e?.message||'Connexion impossible')};}
    resourceHealthCache.set(item.id,{at:Date.now(),value});results.set(item.id,value);
  }));
  for(const integration of managed){
    const current=results.get(integration.id);
    add('api-'+integration.id, integration.name+' · API',current?.ok?'ready':current?'error':'partial',
      current?.ok?'API joignable.':current?'Test échoué : '+(current.reason||'Erreur inconnue'):'Intégration enregistrée, non testée pour ce panneau.',
      current?.ok?[]:['Dans Intégrations API, cliquer sur Tester pour vérifier les identifiants et l’accès réseau.'],'integrations');
  }
  return {checkedAt:new Date().toISOString(),sources:result,collector:{path:METRICS,lastUpdate:snapshot.probeAt||null,fresh:snapshot.probeFresh,script:'/scripts/collect-nas.sh'}};
}

const files={'/':'index.html','/index.html':'index.html','/login':'login.html','/style.css':'style.css','/app.js':'app.js','/integrations':'integrations.html','/integrations.js':'integrations.js','/integrations.css':'integrations.css','/widgets.js':'widgets.js','/settings':'settings.html','/settings.js':'settings.js','/settings.css':'settings.css','/dashboard-cards.js':'dashboard-cards.js','/experience.js':'experience.js','/preferences-settings.js':'preferences-settings.js'};
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url||'/', 'http://localhost').pathname;
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
  try{
    if(pathname==='/healthz' && req.method==='GET')return json(res,200,{ok:true});
    if(pathname==='/api/session' && req.method==='GET')return json(res,200,{authenticated:authorized(req)});
    if(pathname==='/api/login' && req.method==='POST'){
      if(!sameOrigin(req))return json(res,403,{error:'Origin invalide'});
      const ip=req.socket.remoteAddress||'unknown';
      const rate=failures.get(ip)||{count:0,until:0};
      if(rate.until>Date.now())return json(res,429,{error:'Trop de tentatives. Réessayer plus tard.'});
      const body=await readBody(req,4096);
      if(!safeEqual(String(body.username||''),USER)||!safeEqual(String(body.password||''),PASSWORD)){
        const count=rate.count+1;failures.set(ip,{count,until:count>=5?Date.now()+300000:0});
        return json(res,401,{error:'Identifiants incorrects'});
      }
      failures.delete(ip);
      const token=crypto.randomBytes(32).toString('base64url');
      sessions.set(hashToken(token),Date.now()+12*60*60*1000);
      return json(res,200,{ok:true},{'Set-Cookie':cookie(req,token,12*60*60)});
    }
    if(pathname==='/api/logout' && req.method==='POST'){
      if(!sameOrigin(req))return json(res,403,{error:'Origin invalide'});
      const token=cookies(req).pablo_session;if(token)sessions.delete(hashToken(token));
      return json(res,200,{ok:true},{'Set-Cookie':cookie(req,'',0)});
    }
    if(pathname.startsWith('/api/')){
      if(!authorized(req))return json(res,401,{error:'Authentification requise'});
      // RSS is intentionally decoupled from the NAS/media status endpoint.
      // A failure elsewhere must never hide independently available articles.
      if(pathname==='/api/rss'&&req.method==='GET')return json(res,200,await feedReader.read());
      if(pathname==='/api/status'&&req.method==='GET')return json(res,200,await status());
      if(pathname==='/api/experience'&&req.method==='GET')return json(res,200,preferences.read());
      if(pathname==='/api/overview/options'&&req.method==='GET')return json(res,200,{options:OVERVIEW_METRICS});
      if(pathname==='/api/setup/diagnostics'&&req.method==='GET')return json(res,200,await diagnosticStatus(await status()));
      if(pathname==='/api/catalog'&&req.method==='GET')return json(res,200,{presets:PRESETS,metrics:METRIC_TEMPLATES});
      if(pathname==='/api/dashboard'&&req.method==='GET')return json(res,200,dashboard.list());
      if(pathname==='/api/dashboard/data'&&req.method==='GET')return json(res,200,await dashboard.readData(await status()));
      if(pathname==='/api/dashboard/export'&&req.method==='GET')return json(res,200,dashboard.exportLayout());
      if(pathname==='/api/integrations'&&req.method==='GET')return json(res,200,{items:store.list()});
      if(pathname==='/api/widgets'&&req.method==='GET')return json(res,200,{items:store.listWidgets()});
      if(pathname==='/api/widgets/data'&&req.method==='GET')return json(res,200,{items:await store.readWidgets()});
      if(req.method!=='POST' || !sameOrigin(req))return json(res,403,{error:'Action interdite'});
      if(pathname==='/api/experience') {
        try{const updated=preferences.save(await readBody(req,110000));caches.clear();resourceHealthCache.clear();return json(res,200,updated);}
        catch(e){return json(res,400,{error:String(e.message).slice(0,200)});}
      }
      if(pathname==='/api/rss/test') {
        try{const input=await readBody(req,4096);const result=await feedReader.test(input.url);return json(res,200,{...result,items:result.items.slice(0,3)});}
        catch(e){return json(res,400,{error:String(e.message).slice(0,200)});}
      }
      if(pathname==='/api/dashboard/preview') {
        try{return json(res,200,await dashboard.previewMetric(await readBody(req,24576),await status()));}
        catch(e){return json(res,400,{error:String(e.message).slice(0,200)});}
      }
      if(pathname==='/api/dashboard/inspect') {
        try{return json(res,200,await dashboard.inspectApi(await readBody(req,24576)));}
        catch(e){return json(res,400,{error:String(e.message).slice(0,200)});}
      }
      if(pathname==='/api/dashboard/cards') {
        try{return json(res,200,{item:dashboard.upsertCard(await readBody(req,24576))});}
        catch(e){return json(res,400,{error:String(e.message).slice(0,200)});}
      }
      if(pathname==='/api/dashboard/cards/reorder') {
        try{return json(res,200,dashboard.reorderCards((await readBody(req,24576)).ids));}
        catch(e){return json(res,400,{error:String(e.message).slice(0,200)});}
      }
      if(pathname==='/api/dashboard/import') {
        try{return json(res,200,dashboard.importLayout(await readBody(req,500000)));}
        catch(e){return json(res,400,{error:String(e.message).slice(0,200)});}
      }
      if(pathname==='/api/dashboard/reset') {
        try{return json(res,200,dashboard.reset());}
        catch(e){return json(res,400,{error:String(e.message).slice(0,200)});}
      }
      const cardAction=pathname.match(/^\/api\/dashboard\/cards\/([a-z0-9-]{1,56})\/(delete|duplicate)$/);
      if(cardAction) {
        try{return json(res,200,cardAction[2]==='delete'?(dashboard.deleteCard(cardAction[1]),{ok:true}):{item:dashboard.duplicateCard(cardAction[1])});}
        catch(e){return json(res,400,{error:String(e.message).slice(0,200)});}
      }
      const cardRow=pathname.match(/^\/api\/dashboard\/cards\/([a-z0-9-]{1,56})\/rows(?:\/(reorder|delete|duplicate))?$/);
      if(cardRow) {
        try {
          const body=await readBody(req,24576);
          if(cardRow[2]==='reorder')return json(res,200,{item:dashboard.reorderRows(cardRow[1],body.ids)});
          return json(res,200,{item:dashboard.rowAction(cardRow[1],cardRow[2]||'upsert',body)});
        } catch(e){return json(res,400,{error:String(e.message).slice(0,200)});}
      }
      if(pathname==='/api/integrations') {
        try {return json(res,201,{item:store.create(await readBody(req,24576))});}
        catch(e){return json(res,400,{error:String(e.message).slice(0,200)});}
      }
      const integrationTest=pathname.match(/^\/api\/integrations\/([0-9a-f-]{36})\/test$/);
      if(integrationTest)return json(res,200,await store.test(integrationTest[1]));
      const integrationUpdate=pathname.match(/^\/api\/integrations\/([0-9a-f-]{36})\/(update|delete)$/);
      if(integrationUpdate) {
        try {return json(res,200,integrationUpdate[2]==='delete'?(dashboard.removeIntegrationReferences(integrationUpdate[1]),store.remove(integrationUpdate[1]),{ok:true}):{item:store.update(integrationUpdate[1],await readBody(req,24576))});}
        catch(e){return json(res,400,{error:String(e.message).slice(0,200)});}
      }
      if(pathname==='/api/widgets') {
        try {return json(res,201,{item:store.upsertWidget(await readBody(req,24576))});}
        catch(e){return json(res,400,{error:String(e.message).slice(0,200)});}
      }
      if(pathname==='/api/widgets/reorder') {
        try {return json(res,200,{items:store.reorder((await readBody(req,24576)).ids)});}
        catch(e){return json(res,400,{error:String(e.message).slice(0,200)});}
      }
      const widgetDelete=pathname.match(/^\/api\/widgets\/([0-9a-f-]{36})\/delete$/);
      if(widgetDelete){store.removeWidget(widgetDelete[1]);return json(res,200,{ok:true});}
      return json(res,404,{error:'API inconnue'});
    }
    if(!(pathname in files)||req.method!=='GET')return json(res,404,{error:'Page introuvable'});
    if(pathname==='/integrations'){res.writeHead(302,{Location:'/settings?tab=integrations'});return res.end();}
    if(pathname==='/login'&&authorized(req)){res.writeHead(302,{Location:'/'});return res.end();}
    if(!['/login','/style.css','/app.js','/integrations.css','/integrations.js','/widgets.js','/settings.js','/settings.css','/dashboard-cards.js','/experience.js','/preferences-settings.js'].includes(pathname)&&!authorized(req)){res.writeHead(302,{Location:'/login'});return res.end();}
    const filename=path.join(ROOT,'public',files[pathname]);
    res.writeHead(200,{'Content-Type':mime[path.extname(filename)],'Cache-Control':'no-store'});return fs.createReadStream(filename).pipe(res);
  }catch(err){console.error('[PabloHFlix] Requête en échec',pathname,err?.message||err);return json(res,500,{error:'Erreur interne — consulter les logs du conteneur et Settings → Sources'});}
});
if(process.argv[1]===fileURLToPath(import.meta.url)) server.listen(PORT,'0.0.0.0',()=>console.log(`PabloHFlix Console listening on ${PORT}`));
export { server,collectSnapshot,collectHost,status,safeEqual,decodeXml,parseSmartDisks };
