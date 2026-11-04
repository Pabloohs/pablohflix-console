import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

const guid = () => crypto.randomUUID();
const copy = value => JSON.parse(JSON.stringify(value));
const safeLabel = (value, max=70) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\r\n<>]/.test(value)) throw Error('Nom invalide');
  return value.trim();
};
const validId = value => typeof value === 'string' && /^(?:[a-z][a-z0-9-]{1,49}|[0-9a-f-]{36})$/i.test(value);
const validWebUrl = (raw,{rss=false}={}) => {
  if (typeof raw !== 'string' || raw.length>500) throw Error('URL invalide');
  let parsed;
  try{parsed=new URL(raw);}catch{throw Error('URL invalide');}
  if ((rss && parsed.protocol!=='https:') || (!rss&&!['https:','http:'].includes(parsed.protocol))) throw Error(rss?'Flux RSS : URL HTTPS obligatoire':'URL HTTP(S) obligatoire');
  if(parsed.username||parsed.password||parsed.hash || !parsed.hostname)throw Error('URL avec identifiants ou fragment refusée');
  return parsed.href;
};
const DEFAULT = Object.freeze({
  version:1,
  feedGroups:[{id:'cyber',name:'Cybersécurité'}],
  feeds:[{id:'cert-fr',groupId:'cyber',name:'CERT-FR',url:'https://www.cert.ssi.gouv.fr/feed/',enabled:true}],
  quickGroups:[{id:'media',name:'Multimédia'},{id:'infrastructure',name:'Infrastructure'}],
  quickLinks:[
    ['Jellyfin',8096,'media'],['Seerr',5055,'media'],['Radarr',7878,'media'],['Sonarr',8989,'media'],
    ['Prowlarr',9696,'media'],['Bazarr',6767,'media'],['qBittorrent',8090,'media'],
    ['Pi-hole',8888,'infrastructure'],['NPM',8181,'infrastructure'],['Recordstudio',18080,'infrastructure'],
  ].map(([name,port,groupId])=>({id:guid(),name,groupId,url:`http://192.168.1.200:${port}`})),
  overview:['docker','vpn','alerts'],
  resourceSources:['jellyfin','radarr','sonarr','docker','volume1','volume2','smart','rss'],
  vpns:{media:{integrationId:'',expectedCountry:''},record:{integrationId:'',expectedCountry:'CH'}},
});
export const OVERVIEW_METRICS=Object.freeze([
  {id:'docker',name:'Docker · actifs/total'},
  {id:'vpn',name:'VPN · actifs/configurés'},
  {id:'alerts',name:'Alertes confirmées'},
  {id:'storage',name:'Volume 1 · occupation'},
  {id:'sources',name:'Sources disponibles'},
  {id:'rss',name:'Actualités RSS'},
]);
const idsUnique = values => new Set(values.map(x=>x.id)).size===values.length;
function validate(input){
  if(!input || typeof input!=='object'||Array.isArray(input))throw Error('Configuration invalide');
  const groups=(key,max)=>{
    const arr=input[key];if(!Array.isArray(arr)||arr.length>max)throw Error(`${key} : limite dépassée`);
    const rows=arr.map(x=>{if(!validId(x?.id))throw Error('ID de groupe invalide');return {id:x.id,name:safeLabel(x.name)};});
    if(!idsUnique(rows))throw Error('Groupes dupliqués');return rows;
  };
  const feedGroups=groups('feedGroups',12),quickGroups=groups('quickGroups',12);
  const fg=new Set(feedGroups.map(x=>x.id)),qg=new Set(quickGroups.map(x=>x.id));
  if(!fg.size||!qg.size)throw Error('Un groupe minimum est nécessaire');
  if(!Array.isArray(input.feeds)||input.feeds.length>24)throw Error('Limite : 24 flux RSS');
  if(!Array.isArray(input.quickLinks)||input.quickLinks.length>60)throw Error('Limite : 60 raccourcis');
  const feeds=input.feeds.map(x=>{
    if(!validId(x?.id)||!fg.has(x.groupId))throw Error('Flux RSS : groupe/ID invalide');
    return {id:x.id,name:safeLabel(x.name),groupId:x.groupId,url:validWebUrl(x.url,{rss:true}),enabled:x.enabled!==false};
  });
  const quickLinks=input.quickLinks.map(x=>{
    if(!validId(x?.id)||!qg.has(x.groupId))throw Error('Raccourci : groupe/ID invalide');
    return {id:x.id,name:safeLabel(x.name),groupId:x.groupId,url:validWebUrl(x.url)};
  });
  if(!idsUnique(feeds)||!idsUnique(quickLinks))throw Error('ID dupliqué');
  const overview=input.overview;
  const allowed=new Set(OVERVIEW_METRICS.map(x=>x.id));
  if(!Array.isArray(overview)||overview.length>4||new Set(overview).size!==overview.length||!overview.every(v=>allowed.has(v)))throw Error('Indicateurs de synthèse invalides');
  const resourceSources=input.resourceSources??['jellyfin','radarr','sonarr','docker','smart','rss'];
  if(!Array.isArray(resourceSources)||resourceSources.length>22||new Set(resourceSources).size!==resourceSources.length||!resourceSources.every(x=>typeof x==='string'&&(/^[a-z][a-z0-9]{1,20}$/.test(x)||/^api-[0-9a-f-]{36}$/i.test(x))))throw Error('Sources affichées invalides');
  const vpns={};
  for(const key of ['media','record']){
    const v=input.vpns?.[key]||{};
    const integrationId=v.integrationId||'';
    if(integrationId && !/^[0-9a-f-]{36}$/i.test(integrationId))throw Error('Connexion VPN invalide');
    const expectedCountry=String(v.expectedCountry||'').trim().toUpperCase();
    if(expectedCountry&&!/^[A-Z]{2}$/.test(expectedCountry))throw Error('Code pays VPN invalide : 2 lettres attendues');
    vpns[key]={integrationId,expectedCountry};
  }
  return {version:1,feedGroups,feeds,quickGroups,quickLinks,overview,resourceSources,vpns};
}
export function createPreferenceStore({dir}){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,'experience.json');
  let state=copy(DEFAULT);
  if(fs.existsSync(file))state=validate(JSON.parse(fs.readFileSync(file,'utf8')));
  const read=()=>copy(state);
  const save=input=>{
    const validated=validate(input);
    const temporary=`${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(validated,null,2),{mode:0o600,flag:'wx'});
    fs.renameSync(temporary,file);state=validated;return read();
  };
  if(!fs.existsSync(file))save(state);
  return {read,save};
}
function publicIPv4(ip){
  if(isIP(ip)!==4)return false;
  const [a,b,c,d]=ip.split('.').map(Number);
  if(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&b>=18&&b<=19||a===192&&b===0&&c===0||a===192&&b===0&&c===2||a===198&&b===51&&c===100||a===203&&b===0&&c===113||a===192&&b===88&&c===99)return false;
  return d>=0;
}
// Node 22 may request lookup({all:true}) when auto-selecting address families.
// Its callback must then receive [{address, family}], not a bare IP string.
export function pinnedIpv4Lookup(ip) {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{address:ip, family:4}]);
    else callback(null, ip, 4);
  };
}

export async function downloadFeed(url,redirects=0){
  const parsed=new URL(validWebUrl(url,{rss:true}));
  const addrs=await lookup(parsed.hostname,{family:4,all:true});
  if(!addrs.length||addrs.some(x=>!publicIPv4(x.address)))throw Error('Hôte RSS privé ou non autorisé');
  // Pin DNS for this request to prevent DNS rebinding. TLS still validates the original hostname.
  const pinned=addrs[0].address;
  return await new Promise((resolve,reject)=>{
    const req=https.request(parsed,{method:'GET',lookup:pinnedIpv4Lookup(pinned),timeout:7500,headers:{'Accept':'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9','User-Agent':'PabloHFlixConsole/0.4 (RSS reader)','Accept-Encoding':'identity'}},res=>{
      if(res.statusCode>=300&&res.statusCode<400 && res.headers.location){
        res.resume();
        if(redirects>=2){reject(Error('Trop de redirections RSS'));return;}
        let next;try{next=new URL(res.headers.location,parsed).href;validWebUrl(next,{rss:true});}
        catch{reject(Error('Redirection RSS non HTTPS ou non valide'));return;}
        resolve(downloadFeed(next,redirects+1));return;
      }
      if(res.statusCode<200||res.statusCode>=300){res.resume();reject(Error('RSS HTTP '+res.statusCode));return;}
      let length=0;const data=[];
      res.on('data',chunk=>{length+=chunk.length;if(length>700000){res.destroy(Error('Flux RSS trop volumineux'));return;}data.push(chunk);});
      res.on('end',()=>resolve(Buffer.concat(data).toString('utf8')));
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(Error('Délai RSS dépassé')));
    req.on('error',reject);
    req.end();
  });
}
const decodeXml=value=>String(value||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
  .replace(/<[^>]+>/g,'').replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|\d+);/gi,raw=>{
    if(raw.startsWith('&#')){const n=raw[2]==='x'?parseInt(raw.slice(3,-1),16):parseInt(raw.slice(2,-1),10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}
    return {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[raw.toLowerCase()]||raw;
  }).trim();
const tagText=(body,tag)=>decodeXml((body.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'))||[])[1]);
export function parseFeed(xml){
  if(typeof xml!=='string'||!/<(?:rss|feed|rdf:RDF)\b/i.test(xml))throw Error('Document non reconnu comme RSS/Atom');
  const atom=/<feed\b/i.test(xml);
  const candidates=[...xml.matchAll(atom?/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi:/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  const entries=[];
  for(const [,body] of candidates.slice(0,50)){
    const title=tagText(body,'title').slice(0,240);
    const rawLink=atom?(body.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?>/i)||[])[1]||tagText(body,'link'):tagText(body,'link');
    let href;
    try{const u=new URL(decodeXml(rawLink));if(!['http:','https:'].includes(u.protocol))continue;href=u.href;}catch{continue;}
    if(title)entries.push({title,link:href,at:tagText(body,atom?'updated':'pubDate')||tagText(body,atom?'published':'dc:date')});
  }
  return entries;
}
export function createFeedReader({preferences,fetchXml=downloadFeed,ttlMs=600000}){
  const cache=new Map();
  async function query(feed,{fresh=false}={}){
    const cached=cache.get(feed.url);
    if(!fresh&&cached&&Date.now()-cached.time<ttlMs)return cached.result;
    let result;
    try{
      const xml=await fetchXml(feed.url);
      const items=parseFeed(xml);
      if(!items.length)throw Error('Flux vide ou aucun article compatible');
      result={ok:true,items,checkedAt:new Date().toISOString()};
    }catch(e){result={ok:false,items:cached?.result?.items||[],reason:String(e?.message||'Erreur RSS').slice(0,160),checkedAt:new Date().toISOString(),stale:Boolean(cached?.result?.items?.length)};}
    cache.set(feed.url,{time:Date.now(),result});return result;
  }
  async function read({fresh=false}={}){
    const cfg=preferences.read();const feeds=cfg.feeds.filter(f=>f.enabled);
    const responses=await Promise.all(feeds.map(async feed=>({feedId:feed.id,groupId:feed.groupId,name:feed.name,...await query(feed,{fresh})})));
    const items=responses.flatMap(f=>f.items.slice(0,6).map(x=>({...x,source:f.name,feedId:f.feedId,groupId:f.groupId,stale:!!f.stale}))).slice(0,80);
    return {items,feeds:responses.map(({items,...rest})=>({...rest,count:items.length})),groups:cfg.feedGroups};
  }
  async function test(url){return query({url:validWebUrl(url,{rss:true})},{fresh:true});}
  return {read,test};
}
