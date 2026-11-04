import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const PRESETS = Object.freeze([
  { type: 'jellyfin', label: 'Jellyfin', port: 8096, endpoint: '/Sessions', field: 'streams', metricLabel: 'Lectures en cours', auth: 'apiKey' },
  { type: 'radarr', label: 'Radarr', port: 7878, endpoint: '/api/v3/queue?page=1&pageSize=1', field: 'queue', metricLabel: 'File Radarr', auth: 'apiKey' },
  { type: 'sonarr', label: 'Sonarr', port: 8989, endpoint: '/api/v3/queue?page=1&pageSize=1', field: 'queue', metricLabel: 'File Sonarr', auth: 'apiKey' },
  { type: 'seerr', label: 'Seerr', port: 5055, endpoint: '/api/v1/request/count', field: 'pending', metricLabel: 'Demandes en attente', auth: 'apiKey' },
  { type: 'prowlarr', label: 'Prowlarr', port: 9696, endpoint: '/api/v1/health', field: 'health', metricLabel: 'Alertes Prowlarr', auth: 'apiKey' },
  { type: 'bazarr', label: 'Bazarr', port: 6767, endpoint: '/api/system/status', field: 'version', metricLabel: 'Version Bazarr', auth: 'apiKey' },
  { type: 'recordstudio', label: 'Recordstudio', port: 18080, endpoint: '/api/state', field: 'status', metricLabel: 'Statut', auth: 'basic' },
  { type: 'gluetun', label: 'Gluetun', port: 8000, endpoint: '/v1/vpn/status', field: 'status', metricLabel: 'VPN', auth: 'none' },
  { type: 'pihole', label: 'Pi-hole v6', port: 80, endpoint: '/api/stats/summary', field: 'queries.total', metricLabel: 'DNS résolus', auth: 'apiKey' },
  { type: 'custom', label: 'Application personnalisée / REST JSON', port: null, endpoint: '/', field: '', metricLabel: 'Valeur API', auth: 'header' },
]);
const TYPES = new Map(PRESETS.map(p => [p.type, p]));
const MAX_INTEGRATIONS = 50;
const MAX_WIDGETS = 80;
const MAX_JSON_BYTES = 1_000_000;
const RESERVED_IPS = /^(?:0\.|127\.|169\.254\.|224\.|225\.|226\.|227\.|228\.|229\.|23[0-9]\.|24[0-9]\.|25[0-5]\.)/;
const PRIVATE_IPS = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)/;

// Jellyfin 12 no longer accepts the legacy X-Emby-Token header by default.
export function jellyfinAuthHeaders(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey || /[\r\n"]/u.test(apiKey)) throw new Error('Clé API Jellyfin invalide');
  return {Authorization: `MediaBrowser Token="${apiKey}"`};
}


function requireText(value, max, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} invalide`);
  return value.trim();
}
function toId() { return crypto.randomUUID(); }
function normalizeUrl(raw) {
  const value = requireText(raw, 240, 'Adresse');
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('HTTP(S) requis');
  if (url.username || url.password || url.hash || url.search || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Utiliser uniquement l’URL de base (sans chemin ni identifiants)');
  // WHATWG URL strips default :80 and :443; accept them only if explicitly supplied.
  const authority=value.match(/^https?:\/\/([^/]+)/i)?.[1]||'';
  const explicitPort=/:([0-9]{1,5})$/.exec(authority)?.[1];
  if (!explicitPort || Number(explicitPort) < 1 || Number(explicitPort) > 65535) throw new Error('Port explicite requis pour la configuration privée');
  if (isIP(url.hostname) === 4 && (!PRIVATE_IPS.test(url.hostname) || RESERVED_IPS.test(url.hostname))) throw new Error('Adresse réseau non privée ou réservée');
  if (isIP(url.hostname) === 6 && !url.hostname.startsWith('fd')) throw new Error('Adresse IPv6 non privée');
  return url.origin;
}
function allowedHost(hostname) {
  const host = hostname.toLowerCase();
  // Local integrations are added by an authenticated administrator in the web UI.
  // The destination is still restricted to private IP ranges after DNS resolution.
  return host.length > 0 && host.length <= 253;
}
async function verifyDestination(url) {
  if (!allowedHost(url.hostname)) throw new Error('Hôte non autorisé');
  const hostname = url.hostname.toLowerCase();
  let ips;
  if (isIP(hostname)) ips = [hostname];
  else ips = (await lookup(hostname, {all:true})).map(item => item.address);
  if (!ips.length) throw new Error('Résolution DNS impossible');
  for(const ip of ips) {
    if (!isIP(ip) || (isIP(ip) === 4 && (!PRIVATE_IPS.test(ip) || RESERVED_IPS.test(ip))) || (isIP(ip) === 6 && !ip.startsWith('fd'))) {
      throw new Error('Adresse non privée ou réservée : connexion refusée');
    }
  }
}
function normalizePath(raw, name = 'Chemin API') {
  const value = requireText(raw, 180, name);
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('#') || value.includes('..') || /[\r\n]/.test(value)) throw new Error(`${name} invalide`);
  return value;
}
function normalizeField(raw) {
  if (typeof raw !== 'string' || raw.length > 120 || !/^[a-zA-Z0-9_$.[\]-]*$/.test(raw) || raw.split(/[.\[\]]+/).some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Chemin JSON invalide');
  return raw;
}
function pickJson(obj, field) {
  if (!field) return typeof obj === 'object' && obj !== null ? null : obj;
  let value = obj;
  for (const part of field.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (part === 'length') { value = Array.isArray(value) || typeof value === 'string' ? value.length : undefined; continue; }
    if (!/^[A-Za-z_$][\w$]*$|^\d+$/.test(part) || ['__proto__','prototype','constructor'].includes(part)) return null;
    value = value?.[part];
    if (value === undefined) return null;
  }
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? value : null;
}
function convertValue(type, response, field) {
  if (type === 'jellyfin' && field === 'streams') return Array.isArray(response) ? response.filter(x => x?.NowPlayingItem).length : null;
  if ((type === 'radarr' || type === 'sonarr') && field === 'queue') return response?.totalRecords ?? null;
  if (type === 'prowlarr' && field === 'health') return Array.isArray(response) ? response.length : null;
  return pickJson(response, field);
}
export function createIntegrationStore({dir, secret, fetchImpl = fetch}) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Clé de chiffrement absente');
  const file = path.join(dir, 'integrations.json');
  const encryptionKey = crypto.createHash('sha256').update(`pablohflix-connectors-v1:${secret}`).digest();
  const encrypt = text => {
    if (!text) return '';
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey,iv);
    const buffer=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
    return [iv,cipher.getAuthTag(),buffer].map(b=>b.toString('base64url')).join('.');
  };
  const decrypt = value => {
    if (!value) return '';
    const [nonce,tag,encrypted]=value.split('.').map(s=>Buffer.from(s,'base64url'));
    const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey,nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8');
  };
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  let state={version:1, integrations:[], widgets:[]};
  if(fs.existsSync(file)) {
    const parsed=JSON.parse(fs.readFileSync(file,'utf8'));
    if(parsed.version!==1 || !Array.isArray(parsed.integrations) || !Array.isArray(parsed.widgets)) throw new Error('Configuration intégrations incompatible');
    state=parsed;
  }
  function save() {
    const temporary=`${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(state,null,2),{mode:0o600,flag:'wx'});
    fs.renameSync(temporary,file);
  }
  const publicIntegration = item => ({id:item.id,name:item.name,type:item.type,url:item.url,endpoint:item.endpoint,field:item.field,hasSecret:!!item.encryptedSecret,auth:item.auth,customHeader:item.auth==='header'?item.headerName:null,createdAt:item.createdAt});
  function list() { return state.integrations.map(publicIntegration); }
  function getInternalForType(type) {
    const item=state.integrations.find(x=>x.type===type);
    if(!item)return null;
    return {url:item.url,apiKey:decrypt(item.encryptedSecret)};
  }
  function normalizeInput(input, prior) {
    const type=String(input.type ?? prior?.type ?? 'custom');
    if(!TYPES.has(type)) throw new Error('Type d’intégration inconnu');
    const preset=TYPES.get(type);
    const auth=String(input.auth ?? prior?.auth ?? preset.auth);
    if(!['none','apiKey','bearer','basic','header'].includes(auth))throw new Error('Authentification inconnue');
    const secretInput = typeof input.secret==='string' ? input.secret.trim() : undefined;
    const key=secretInput!==undefined && secretInput!==''?encrypt(secretInput):prior?.encryptedSecret||'';
    if(auth!=='none' && !key)throw new Error('Clé API ou identifiants requis');
    const username=auth==='basic'?requireText(input.username ?? prior?.username ?? '',100,'Utilisateur API'):'';
    const headerName=auth==='header'?requireText(input.headerName ?? prior?.headerName ?? 'X-Api-Key',60,'Nom de l’en-tête'):'';
    if(headerName && !/^[A-Za-z0-9-]+$/.test(headerName))throw new Error('Nom d’en-tête invalide');
    return {
      id:prior?.id||toId(),type,name:requireText(input.name ?? prior?.name ?? preset.label,64,'Nom'),
      url:normalizeUrl(input.url ?? prior?.url),
      endpoint:normalizePath(input.endpoint ?? prior?.endpoint ?? preset.endpoint),
      field:normalizeField(input.field ?? prior?.field ?? preset.field),
      auth,encryptedSecret:key,username,headerName,createdAt:prior?.createdAt||new Date().toISOString(),
    };
  }
  function create(input) {
    if(state.integrations.length>=MAX_INTEGRATIONS)throw new Error('Limite d’intégrations atteinte');
    const item=normalizeInput(input);state.integrations.push(item);save();return publicIntegration(item);
  }
  function update(id,input) {
    const i=state.integrations.findIndex(x=>x.id===id);if(i<0)throw new Error('Intégration inconnue');
    const item=normalizeInput(input,state.integrations[i]);state.integrations[i]=item;save();return publicIntegration(item);
  }
  function remove(id) {
    if(!state.integrations.some(x=>x.id===id))throw new Error('Intégration inconnue');
    state.integrations=state.integrations.filter(x=>x.id!==id);
    state.widgets=state.widgets.filter(x=>x.integrationId!==id);save();
  }
  async function queryData(id, endpointOverride='') {
    const item=state.integrations.find(x=>x.id===id);if(!item)throw new Error('Intégration inconnue');
    const endpoint=endpointOverride ? normalizePath(endpointOverride) : item.endpoint;
    const url=new URL(item.url+endpoint);
    await verifyDestination(url);
    const headers={'Accept':'application/json'};
    const secret=decrypt(item.encryptedSecret);
    if(item.type==='pihole' && item.auth==='apiKey'){
      // Pi-hole v6 does not accept X-Api-Key: use its short-lived FTL session.
      const loginUrl=new URL(item.url+'/api/auth');
      await verifyDestination(loginUrl);
      const login=await fetchImpl(loginUrl,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({password:secret}),redirect:'manual',signal:AbortSignal.timeout(7000)});
      if(!login.ok)throw Error(`Pi-hole authentification HTTP ${login.status}`);
      const body=await login.text();
      if(body.length>8192)throw Error('Réponse auth Pi-hole trop volumineuse');
      const sid=JSON.parse(body)?.session?.sid;
      if(typeof sid!=='string'||!sid||/[\r\n]/.test(sid))throw Error('Session Pi-hole absente');
      headers['X-FTL-SID']=sid;
    } else if(item.auth==='apiKey') {
      if(item.type==='jellyfin') Object.assign(headers,jellyfinAuthHeaders(secret));
      else headers['X-Api-Key']=secret;
    }
    if(item.auth==='bearer')headers.Authorization=`Bearer ${secret}`;
    if(item.auth==='basic')headers.Authorization='Basic '+Buffer.from(`${item.username}:${secret}`).toString('base64');
    if(item.auth==='header')headers[item.headerName]=secret;
    const response=await fetchImpl(url,{headers,redirect:'manual',signal:AbortSignal.timeout(7000)});
    if(response.status>=300&&response.status<400)throw new Error('Redirection refusée');
    if(!response.ok)throw new Error(`API HTTP ${response.status}`);
    const raw=await response.text();if(raw.length>MAX_JSON_BYTES)throw new Error('Réponse JSON trop volumineuse');
    return JSON.parse(raw);
  }
  async function query(id) { return queryData(id); }
  function convertMetricValue(response,field,transform='value',type='') {
    if(transform==='arrayLength')return Array.isArray(response)?response.length:null;
    if(transform==='playingSessions')return Array.isArray(response)?response.filter(s=>s?.NowPlayingItem).length:null;
    if(transform==='transcodes')return Array.isArray(response)?response.filter(s=>s?.NowPlayingItem&&(s.TranscodingInfo||s.PlayState?.PlayMethod==='Transcode')).length:null;
    if(transform==='activeUsers')return Array.isArray(response)?new Set(response.filter(s=>s?.NowPlayingItem).map(s=>s.UserId).filter(Boolean)).size:null;
    if(type==='jellyfin'&&field==='streams')return convertValue(type,response,field);
    return pickJson(response,field);
  }
  async function test(id) {
    const item=state.integrations.find(x=>x.id===id);if(!item)throw new Error('Intégration inconnue');
    try {
      const data=await query(id);
      return {ok:true, metric:convertValue(item.type,data,item.field),field:item.field};
    } catch(e) { return {ok:false,reason:e?.name==='TimeoutError'?'Délai de connexion dépassé':String(e.message||'Connexion impossible').slice(0,200)}; }
  }
  function listWidgets() {return state.widgets.map(({id,title,integrationId,field})=>({id,title,integrationId,field}));}
  function upsertWidget(input) {
    const id=input.id ? String(input.id) : toId();
    const integrationId=requireText(input.integrationId,50,'Intégration');
    const owner=state.integrations.find(x=>x.id===integrationId);
    if(!owner)throw new Error('Intégration inconnue');
    const widget={id,title:requireText(input.title,64,'Titre'),integrationId,field:normalizeField(input.field ?? owner.field)};
    const existing=state.widgets.findIndex(x=>x.id===id);
    if(existing>=0)state.widgets[existing]=widget;
    else {
      if(state.widgets.length>=MAX_WIDGETS)throw new Error('Limite de widgets atteinte');
      state.widgets.push(widget);
    }
    save();return widget;
  }
  function removeWidget(id) {state.widgets=state.widgets.filter(x=>x.id!==id);save();}
  function reorder(ids) {
    if(!Array.isArray(ids)||ids.length!==state.widgets.length||new Set(ids).size!==ids.length || !ids.every(id=>state.widgets.some(w=>w.id===id)))throw new Error('Ordre invalide');
    state.widgets=ids.map(id=>state.widgets.find(w=>w.id===id));save();return listWidgets();
  }
  async function readWidgets() {
    const sources=new Map();
    await Promise.all([...new Set(state.widgets.map(w=>w.integrationId))].map(async id => {
      try {sources.set(id,{ok:true,data:await query(id)});}
      catch(e){sources.set(id,{ok:false,reason:e?.name==='TimeoutError'?'Timeout':String(e.message||'Erreur API').slice(0,120)});}
    }));
    return state.widgets.map(w=>{
      const integration=state.integrations.find(x=>x.id===w.integrationId);
      const source=sources.get(w.integrationId);
      return {id:w.id,title:w.title,integrationId:w.integrationId,source:integration?.name||'Inconnu',ok:source?.ok||false,value:source?.ok?convertValue(integration.type,source.data,w.field):null,reason:source?.reason||null};
    });
  }
  return {list,create,update,remove,test,getInternalForType,listWidgets,upsertWidget,removeWidget,reorder,readWidgets,queryData,convertMetricValue};
}
