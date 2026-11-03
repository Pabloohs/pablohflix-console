import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createIntegrationStore, PRESETS, jellyfinAuthHeaders } from './integrations.mjs';
import { createDashboardStore, METRIC_TEMPLATES } from './dashboard.mjs';

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
const store = createIntegrationStore({dir:process.env.DATA_DIR||path.join(ROOT,'data'),secret:SESSION_SECRET||'testing-integration-secret-00000000000000000000'});
const dashboard = createDashboardStore({dir:process.env.DATA_DIR||path.join(ROOT,'data'),integrations:store});
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
  return {cpu,ram: memTotal?Math.round(100*(1-memFree/memTotal)):null,ramBytes:memTotal,uptimeSeconds:Math.floor(os.uptime()), note:'Mesures OS indicatives en conteneur ; valider avec UGOS/Beszel'};
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
  const disksRaw=fresh?localFile('disks.psv'):null;
  const disks=disksRaw===null?[]:disksRaw.trim().split(/\r?\n/).filter(Boolean).map(line=>{
    const [device,model,size,health,temp]=line.split('|');
    return {device:(device||'').slice(0,32),model:(model||'').slice(0,64),size:(size||'').slice(0,22),health:['PASSED','FAILED','UNKNOWN'].includes(health)?health:'UNKNOWN',tempC:(/^\d+$/.test(temp||''))?number(temp):null};
  });
  return {docker,volumes,disks,probeAt,probeFresh:Boolean(fresh)};
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
  const url=endpoint('PIHOLE_URL',''); if(!url)return {ok:false,queries:null,blockedPercent:null};
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
  const url=endpoint(prefix+'_URL','');
  if(!url)return {ok:false,state:'unknown',ip:null,country:null,expected:process.env[prefix+'_EXPECTED_COUNTRY']||null,match:null};
  const key=process.env[prefix+'_API_KEY'];
  const headers=key?{'X-API-Key':key}:{};
  const [status,publicIp]=await Promise.all([
    fetchJson(url+'/v1/vpn/status',headers),fetchJson(url+'/v1/publicip/ip',headers)
  ]);
  const expected=process.env[prefix+'_EXPECTED_COUNTRY']||null;
  const country=publicIp.country_code||publicIp.country||null;
  const match=expected&&country?String(country).toLowerCase()===expected.toLowerCase():null;
  return {ok:true,state:status.status||'unknown',ip:publicIp.public_ip||null,country,expected,match};
}
function decodeXml(s){return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();}
async function news(){
  const url=process.env.NEWS_RSS_URL||'https://www.cert.ssi.gouv.fr/feed/';
  const r=await fetch(url,{signal:AbortSignal.timeout(5000),headers:{'User-Agent':'PabloHFlixConsole/0.1'}});
  if(!r.ok)throw Error('news RSS unavailable');
  const xml=(await r.text()).slice(0,250000);
  const entries=[...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].slice(0,8);
  return entries.map(([,body])=>{
    const title=decodeXml((body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||'');
    const link=decodeXml((body.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)||[])[1]||'');
    return {title:title.slice(0,175),link:/^https:\/\//.test(link)?link:null,source:'CERT-FR'};
  }).filter(item=>item.title&&item.link).slice(0,4);
}
async function status(){
  const [j,r,s,requests,dns,mediaVpn,recVpn,cyber]=await Promise.all([
    cached('jellyfin',20000,jellyfin),cached('radarr',30000,()=>arr('RADARR','http://radarr:7878')),
    cached('sonarr',30000,()=>arr('SONARR','http://sonarr:8989')),
    cached('seerr',30000,seerr),cached('pihole',60000,pihole),
    cached('vpnmedia',20000,()=>vpn('VPN_MEDIA')),cached('vpnrecord',20000,()=>vpn('VPN_RECORD')),
    cached('news',1800000,news)
  ]);
  const snapshot=collectSnapshot();
  const results={jellyfin:j,radarr:r,sonarr:s,seerr:requests,pihole:dns,vpnMedia:mediaVpn,vpnRecord:recVpn};
  const configured=Object.values(results).filter(x=>x?.ok===true).length;
  // A network/API error is unknown, not a healthy signal or a proven incident.
  return {timestamp:new Date().toISOString(),system:collectHost(),...snapshot,...results,news:cyber||[],integrations:{responsive:configured,total:7}};
}
const files={'/':'index.html','/index.html':'index.html','/login':'login.html','/style.css':'style.css','/app.js':'app.js','/integrations':'integrations.html','/integrations.js':'integrations.js','/integrations.css':'integrations.css','/widgets.js':'widgets.js','/settings':'settings.html','/settings.js':'settings.js','/settings.css':'settings.css','/dashboard-cards.js':'dashboard-cards.js'};
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
      if(pathname==='/api/status'&&req.method==='GET')return json(res,200,await status());
      if(pathname==='/api/catalog'&&req.method==='GET')return json(res,200,{presets:PRESETS,metrics:METRIC_TEMPLATES});
      if(pathname==='/api/dashboard'&&req.method==='GET')return json(res,200,dashboard.list());
      if(pathname==='/api/dashboard/data'&&req.method==='GET')return json(res,200,await dashboard.readData(await status()));
      if(pathname==='/api/dashboard/export'&&req.method==='GET')return json(res,200,dashboard.exportLayout());
      if(pathname==='/api/integrations'&&req.method==='GET')return json(res,200,{items:store.list()});
      if(pathname==='/api/widgets'&&req.method==='GET')return json(res,200,{items:store.listWidgets()});
      if(pathname==='/api/widgets/data'&&req.method==='GET')return json(res,200,{items:await store.readWidgets()});
      if(req.method!=='POST' || !sameOrigin(req))return json(res,403,{error:'Action interdite'});
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
    if(!['/login','/style.css','/app.js','/integrations.css','/integrations.js','/widgets.js','/settings.js','/settings.css','/dashboard-cards.js'].includes(pathname)&&!authorized(req)){res.writeHead(302,{Location:'/login'});return res.end();}
    const filename=path.join(ROOT,'public',files[pathname]);
    res.writeHead(200,{'Content-Type':mime[path.extname(filename)],'Cache-Control':'no-store'});return fs.createReadStream(filename).pipe(res);
  }catch(err){return json(res,500,{error:'Erreur interne'});}
});
if(process.argv[1]===fileURLToPath(import.meta.url)) server.listen(PORT,'0.0.0.0',()=>console.log(`PabloHFlix Console listening on ${PORT}`));
export { server,collectSnapshot,collectHost,status,safeEqual,decodeXml };
