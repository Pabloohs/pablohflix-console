import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Change NAS_BROWSER_HOST only in the NAS-local .env (never commit its real IP).
const NAS_BROWSER_HOST = (process.env.NAS_BROWSER_HOST || 'nas.local').trim();
const MAX_CARDS = 32;
const MAX_ROWS = 24;
const MAX_TITLE = 70;
const FORMATS = new Set(['auto', 'number', 'percent', 'text', 'bytes', 'duration']);
const TRANSFORMS = new Set(['value', 'arrayLength', 'playingSessions', 'transcodes', 'activeUsers']);
const SOURCE_TYPES = new Set(['status', 'integration']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID = /^(?:[a-z][a-z0-9-]{0,55}|[0-9a-f-]{36})$/i;
const FIELD = /^[a-zA-Z0-9_$.[\]-]*$/;
const PATH = /^\/(?!\/)[^#\r\n]{0,180}$/;
const deepCopy = value => JSON.parse(JSON.stringify(value));
const id = () => crypto.randomUUID();
const text = (v, max, name, fallback = '') => {
  if (typeof v !== 'string') v = fallback;
  const s = v.trim();
  if (!s || s.length > max) throw Error(`${name} invalide`);
  return s;
};
const safeField = value => {
  const s = String(value ?? '');
  if (s.length > 120 || !FIELD.test(s) || s.split(/[.\[\]]+/).some(p => ['__proto__','constructor','prototype'].includes(p))) throw Error('Champ JSON invalide');
  return s;
};
const safeEndpoint = value => {
  const s = String(value || '').trim();
  if (!s || !PATH.test(s) || s.includes('..') || /%2e|%2f|%5c|\\/i.test(s)) throw Error('Endpoint API invalide');
  return s;
};
const isValidId = v => typeof v === 'string' && SHORT_ID.test(v);

const row = (key, label, statusPath, suffix='') => ({id:key,label,enabled:true,sourceType:'status',path:statusPath,integrationId:'',endpoint:'',field:'',transform:'value',format:'auto',suffix});
export const DEFAULT_CARDS = Object.freeze([
  {id:'core-jellyfin',title:'JELLYFIN',icon:'▷',description:'STREAMING',url:`http://${NAS_BROWSER_HOST}:8096`,enabled:true,span:1,rows:[
    row('jelly-streams','Lectures en cours','jellyfin.streams'),
    row('jelly-transcodes','Transcodages QSV / autres','jellyfin.transcodes'),
    row('jelly-users','Utilisateurs actifs','jellyfin.users'),
  ]},
  {id:'core-media-arr',title:'MEDIA-ARR',icon:'⚙',description:'AUTOMATISATION',url:`http://${NAS_BROWSER_HOST}:5055`,enabled:true,span:1,rows:[
    row('radarr-missing','Films en attente','radarr.missing'),
    row('sonarr-missing','Épisodes en attente','sonarr.missing'),
    row('arr-queue','File ARR (Radarr + Sonarr)','computed.arrQueue'),
    row('seerr-pending','Demandes Seerr','seerr.pending'),
  ]},
  {id:'core-recordstudio',title:'RECORDSTUDIO',icon:'◉',description:'CAPTURE VIDÉO',url:`http://${NAS_BROWSER_HOST}:18080`,enabled:true,span:1,rows:[
    row('record-streams','Streams en cours','recordstudio.streams'),
    row('record-free','Stockage libre V2','volumes.volume2.freePercent','%'),
    row('record-country','VPN Suisse','vpnRecord.country'),
  ]},
]);

export const METRIC_TEMPLATES = Object.freeze([
  {id:'jelly-playing',type:'jellyfin',label:'Lectures en cours',endpoint:'/Sessions',field:'',transform:'playingSessions'},
  {id:'jelly-transcodes',type:'jellyfin',label:'Transcodages',endpoint:'/Sessions',field:'',transform:'transcodes'},
  {id:'jelly-users',type:'jellyfin',label:'Utilisateurs actifs',endpoint:'/Sessions',field:'',transform:'activeUsers'},
  {id:'jelly-movies',type:'jellyfin',label:'Films disponibles',endpoint:'/Items/Counts',field:'MovieCount',transform:'value'},
  {id:'jelly-series',type:'jellyfin',label:'Séries disponibles',endpoint:'/Items/Counts',field:'SeriesCount',transform:'value'},
  {id:'jelly-episodes',type:'jellyfin',label:'Épisodes disponibles',endpoint:'/Items/Counts',field:'EpisodeCount',transform:'value'},
  {id:'radarr-movies',type:'radarr',label:'Films suivis',endpoint:'/api/v3/movie',field:'',transform:'arrayLength'},
  {id:'radarr-queue',type:'radarr',label:'File Radarr',endpoint:'/api/v3/queue?page=1&pageSize=1',field:'totalRecords',transform:'value'},
  {id:'sonarr-series',type:'sonarr',label:'Séries suivies',endpoint:'/api/v3/series',field:'',transform:'arrayLength'},
  {id:'sonarr-queue',type:'sonarr',label:'File Sonarr',endpoint:'/api/v3/queue?page=1&pageSize=1',field:'totalRecords',transform:'value'},
  {id:'seerr-pending',type:'seerr',label:'Demandes Seerr en attente',endpoint:'/api/v1/request/count',field:'pending',transform:'value'},
  {id:'prowlarr-health',type:'prowlarr',label:'Alertes Prowlarr',endpoint:'/api/v1/health',field:'',transform:'arrayLength'},
  {id:'recordstudio-live',type:'recordstudio',label:'Enregistrements actifs',endpoint:'/api/state',field:'streams',transform:'value'},
  {id:'recordstudio-configured',type:'recordstudio',label:'Salons configurés',endpoint:'/api/state',field:'streamers.length',transform:'value'},
  {id:'recordstudio-space',type:'recordstudio',label:'Stockage libre Recordstudio',endpoint:'/api/state',field:'disk.free_percent',transform:'value'},
]);

export function readPath(data, field) {
  if (!field) return data == null || typeof data === 'object' ? null : data;
  let value = data;
  for (const part of String(field).replace(/\[(\d+)\]/g,'.$1').split('.')) {
    if (part === 'length') {value = Array.isArray(value) || typeof value === 'string' ? value.length : null; continue;}
    if (!/^\w+$/.test(part) || ['__proto__','constructor','prototype'].includes(part)) return null;
    value = value?.[part];
    if (value === undefined) return null;
  }
  return value == null || ['string','number','boolean'].includes(typeof value) ? value : null;
}

export function createDashboardStore({dir, integrations}) {
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const filename=path.join(dir,'dashboard.json');
  let state = {version:2,cards:deepCopy(DEFAULT_CARDS)};
  if (fs.existsSync(filename)) {
    const loaded=JSON.parse(fs.readFileSync(filename,'utf8'));
    if (loaded?.version !== 2 || !Array.isArray(loaded.cards)) throw Error('Format dashboard incompatible : sauvegarder le fichier dashboard.json avant migration');
    state=loaded;
  } else {
    // V0.2 stored separate numeric widgets. Preserve them as standalone cards on first startup.
    const old=path.join(dir,'integrations.json');
    if (fs.existsSync(old)) {
      const oldConfig=JSON.parse(fs.readFileSync(old,'utf8'));
      if (Array.isArray(oldConfig.widgets)) {
        for (const w of oldConfig.widgets.slice(0,MAX_CARDS-state.cards.length)) {
          if (!isValidId(w.integrationId)) continue;
          state.cards.push({id:id(),title:String(w.title||'Widget').slice(0,MAX_TITLE),icon:'◇',description:'API PERSONNALISÉE',url:'',enabled:true,span:1,rows:[{id:id(),label:String(w.title||'Valeur').slice(0,MAX_TITLE),enabled:true,sourceType:'integration',path:'',integrationId:w.integrationId,endpoint:'',field:String(w.field||'').slice(0,120),transform:'value',format:'auto',suffix:''}]});
        }
      }
    }
  }
  function save() {
    const temp=`${filename}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    fs.writeFileSync(temp,JSON.stringify(state,null,2),{mode:0o600,flag:'wx'});
    fs.renameSync(temp,filename);
  }
  const list=()=>deepCopy(state);
  const hasIntegration=integrationId => integrations.list().some(x=>x.id===integrationId);
  function normalizeRow(input, prior) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Ligne invalide');
    const sourceType=input.sourceType ?? prior?.sourceType ?? 'status';
    if (!SOURCE_TYPES.has(sourceType)) throw Error('Type de source inconnu');
    const transform=input.transform ?? prior?.transform ?? 'value';
    if (!TRANSFORMS.has(transform)) throw Error('Transformation inconnue');
    const format=input.format ?? prior?.format ?? 'auto';
    if (!FORMATS.has(format)) throw Error('Format inconnu');
    const integrationId=sourceType==='integration'?String(input.integrationId??prior?.integrationId??''):'';
    if (sourceType==='integration' && !hasIntegration(integrationId)) throw Error('Intégration inexistante');
    const statusPath=sourceType==='status'?safeField(input.path??prior?.path):'';
    if (sourceType==='status' && (!statusPath || !/^[a-zA-Z]/.test(statusPath))) throw Error('Chemin status manquant');
    const endpoint=sourceType==='integration' && (input.endpoint??prior?.endpoint) ? safeEndpoint(input.endpoint??prior?.endpoint) : '';
    const field=sourceType==='integration'?safeField(input.field??prior?.field??''):'';
    const suffix=String(input.suffix??prior?.suffix??'').trim();
    if (suffix.length>18 || /[<>\r\n]/.test(suffix)) throw Error('Suffixe invalide');
    return {id:prior?.id||id(),label:text(input.label??prior?.label,MAX_TITLE,'Nom de la ligne'),enabled:input.enabled===undefined?(prior?.enabled??true):input.enabled===true,sourceType,path:statusPath,integrationId,endpoint,field,transform,format,suffix};
  }
  function normalizeCard(input, prior) {
    if (!input || typeof input!=='object'||Array.isArray(input)) throw Error('Carte invalide');
    const icon=String(input.icon??prior?.icon??'◇').trim();
    if(!icon || [...icon].length>3 || /[<>\r\n]/.test(icon))throw Error('Icône invalide');
    const url=String(input.url??prior?.url??'').trim();
    if (url) {const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || url.length>250)throw Error('Lien invalide');}
    const desc=String(input.description??prior?.description??'').trim();
    if(desc.length>45 || /[<>\r\n]/.test(desc))throw Error('Description invalide');
    const span=Number(input.span??prior?.span??1);
    if (![1,2,3].includes(span))throw Error('Largeur invalide');
    return {id:prior?.id||id(),title:text(input.title??prior?.title,MAX_TITLE,'Titre'),icon,description:desc,url,enabled:input.enabled===undefined?(prior?.enabled??true):input.enabled===true,span,rows:prior?.rows||[]};
  }
  function upsertCard(input) {
    const existing=input.id?state.cards.find(c=>c.id===input.id):null;
    if(input.id&&!existing)throw Error('Carte inconnue');
    if(!existing && state.cards.length>=MAX_CARDS)throw Error('Nombre maximal de cartes atteint');
    const card=normalizeCard(input,existing);
    if(existing)state.cards[state.cards.indexOf(existing)]=card;
    else state.cards.push(card);
    save();return deepCopy(card);
  }
  function deleteCard(cardId) {
    const index=state.cards.findIndex(c=>c.id===cardId);
    if(index<0)throw Error('Carte introuvable');
    state.cards.splice(index,1);save();
  }
  function duplicateCard(cardId) {
    const original=state.cards.find(c=>c.id===cardId);
    if(!original)throw Error('Carte introuvable');
    if(state.cards.length>=MAX_CARDS)throw Error('Nombre maximal de cartes atteint');
    const copy=deepCopy(original);copy.id=id();copy.title=`${copy.title} · copie`.slice(0,MAX_TITLE);copy.rows.forEach(r=>r.id=id());
    state.cards.splice(state.cards.indexOf(original)+1,0,copy);save();return deepCopy(copy);
  }
  function rowAction(cardId, action, input) {
    const card=state.cards.find(c=>c.id===cardId);
    if(!card)throw Error('Carte inconnue');
    const existing=input?.id?card.rows.find(r=>r.id===input.id):null;
    if(action==='delete') {if(!existing)throw Error('Ligne inconnue');card.rows=card.rows.filter(r=>r!==existing);save();return {ok:true};}
    if(action==='duplicate') {
      if(!existing)throw Error('Ligne inconnue');if(card.rows.length>=MAX_ROWS)throw Error('Nombre maximal de lignes atteint');
      const copy={...existing,id:id(),label:`${existing.label} · copie`.slice(0,MAX_TITLE)};
      card.rows.splice(card.rows.indexOf(existing)+1,0,copy);save();return deepCopy(copy);
    }
    if(input?.id&&!existing)throw Error('Ligne inconnue');
    if(!existing&&card.rows.length>=MAX_ROWS)throw Error('Nombre maximal de lignes atteint');
    const r=normalizeRow(input,existing);
    if(existing)card.rows[card.rows.indexOf(existing)]=r; else card.rows.push(r);
    save();return deepCopy(r);
  }
  function strictReorder(collection, ids) {
    if(!Array.isArray(ids) || ids.length!==collection.length || ids.some(x=>!isValidId(x)) || new Set(ids).size!==ids.length || !ids.every(x=>collection.some(v=>v.id===x))) throw Error('Ordre invalide');
    return ids.map(x=>collection.find(v=>v.id===x));
  }
  function reorderCards(ids) {state.cards=strictReorder(state.cards,ids);save();return list();}
  function reorderRows(cardId,ids){const card=state.cards.find(c=>c.id===cardId);if(!card)throw Error('Carte inconnue');card.rows=strictReorder(card.rows,ids);save();return deepCopy(card);}
  function reset(){state={version:2,cards:deepCopy(DEFAULT_CARDS)};save();return list();}
  function removeIntegrationReferences(integrationId){
    let changed=false;
    for(const card of state.cards){const next=card.rows.filter(r=>r.integrationId!==integrationId);if(next.length!==card.rows.length){card.rows=next;changed=true;}}
    if(changed)save();
  }
  async function readData(statusSnapshot){
    const calculated={
      arrQueue: typeof statusSnapshot?.radarr?.queue==='number'&&typeof statusSnapshot?.sonarr?.queue==='number' ? statusSnapshot.radarr.queue+statusSnapshot.sonarr.queue : null,
    };
    const merged={...statusSnapshot,computed:calculated};
    const work=state.cards.filter(c=>c.enabled).flatMap(c=>c.rows.filter(r=>r.enabled&&r.sourceType==='integration'));
    const fetched=new Map();
    // Distinct endpoints share one HTTP request across all cards/rows in this refresh.
    await Promise.all([...new Set(work.map(r=>r.integrationId+'|'+r.endpoint))].map(async key=>{
      const first=work.find(r=>r.integrationId+'|'+r.endpoint===key);
      try{fetched.set(key,{ok:true,data:await integrations.queryData(first.integrationId,first.endpoint)});}
      catch(e){fetched.set(key,{ok:false,reason:String(e?.message||'Erreur de connexion').slice(0,130)});}
    }));
    return {timestamp:new Date().toISOString(),cards:state.cards.filter(c=>c.enabled).map(card=>({
      ...deepCopy({...card,rows:undefined}),
      rows:card.rows.filter(r=>r.enabled).map(r=>{
        let value=null,ok=false,reason=null;
        if(r.sourceType==='status'){
          value=readPath(merged,r.path);ok=value!==null&&value!==undefined;reason=ok?null:'Donnée indisponible';
        } else {
          const hit=fetched.get(r.integrationId+'|'+r.endpoint);
          if(hit?.ok){value=integrations.convertMetricValue(hit.data,r.field,r.transform,integrations.list().find(i=>i.id===r.integrationId)?.type);ok=value!==null&&value!==undefined;reason=ok?null:'Champ JSON absent ou non numérique';}
          else reason=hit?.reason||'Intégration indisponible';
        }
        return {...r,value:ok?value:null,ok,reason};
      }),
    }))};
  }
  async function previewMetric(input,statusSnapshot){
    const r=normalizeRow({label:'Aperçu',...input});
    if(r.sourceType==='status'){
      const arrQueue=typeof statusSnapshot?.radarr?.queue==='number'&&typeof statusSnapshot?.sonarr?.queue==='number'?statusSnapshot.radarr.queue+statusSnapshot.sonarr.queue:null;
      const value=readPath({...statusSnapshot,computed:{arrQueue}},r.path);
      return {ok:value!==null&&value!==undefined,value:value??null,reason:value==null?'Donnée indisponible':null};
    }
    try{
      const data=await integrations.queryData(r.integrationId,r.endpoint);
      const type=integrations.list().find(x=>x.id===r.integrationId)?.type||'';
      const value=integrations.convertMetricValue(data,r.field,r.transform,type);
      return {ok:value!==null&&value!==undefined,value:value??null,reason:value==null?'Champ JSON absent ou incompatible':null};
    } catch(e){return {ok:false,value:null,reason:String(e.message||'Erreur API').slice(0,160)};}
  }
  async function inspectApi(input){
    if(!hasIntegration(input?.integrationId))throw Error('Intégration inconnue');
    const endpoint=input.endpoint?safeEndpoint(input.endpoint):'';
    const data=await integrations.queryData(input.integrationId,endpoint);
    const found=[];
    const visit=(value,prefix='',depth=0)=>{
      if(found.length>=90||depth>4)return;
      if(Array.isArray(value)){
        found.push({path:prefix?`${prefix}.length`:'length',type:'number'});
        if(value.length)visit(value[0],prefix?`${prefix}[0]`:'[0]',depth+1);
      } else if(value&&typeof value==='object'){
        for(const [key,part] of Object.entries(value).slice(0,45)){
          if(!/^[A-Za-z_$][\w$]*$/.test(key)||['__proto__','constructor','prototype'].includes(key))continue;
          visit(part,prefix?`${prefix}.${key}`:key,depth+1);
        }
      } else if(prefix&&['number','boolean','string'].includes(typeof value)){
        found.push({path:prefix,type:typeof value});
      }
    };
    visit(data);
    // Return paths/types only; never return raw API data or credentials to the browser.
    return {paths:found};
  }
  function exportLayout(){return {version:2,exportedAt:new Date().toISOString(),cards:deepCopy(state.cards)};}
  function importLayout(input){
    if(input?.version!==2||!Array.isArray(input.cards)||input.cards.length>MAX_CARDS)throw Error('Sauvegarde incompatible');
    const oldCards=state.cards;
    const next=[];
    const cardIds=new Set(),rowIds=new Set();
    for(const item of input.cards){
      if(!isValidId(item.id)||cardIds.has(item.id)||!Array.isArray(item.rows)||item.rows.length>MAX_ROWS)throw Error('Carte de sauvegarde invalide');
      cardIds.add(item.id);
      const card={...normalizeCard(item),id:item.id,rows:[]};
      for(const r of item.rows){
        if(!isValidId(r.id)||rowIds.has(r.id))throw Error('Ligne de sauvegarde invalide');
        rowIds.add(r.id);card.rows.push({...normalizeRow(r),id:r.id});
      }
      next.push(card);
    }
    state.cards=next;
    try{save();return list();}catch(e){state.cards=oldCards;throw e;}
  }
  // Persist the default on first run, but never mutate a pre-existing v0.2 file.
  if(!fs.existsSync(filename))save();
  return {list,upsertCard,deleteCard,duplicateCard,rowAction,reorderCards,reorderRows,reset,removeIntegrationReferences,readData,previewMetric,inspectApi,exportLayout,importLayout};
}
