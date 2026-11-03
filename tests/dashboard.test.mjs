import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createIntegrationStore,jellyfinAuthHeaders} from '../integrations.mjs';
import {createDashboardStore,DEFAULT_CARDS,METRIC_TEMPLATES} from '../dashboard.mjs';

const secret='test-secret-more-than-32-bytes-for-dashboard-config';
const mk=()=>fs.mkdtempSync(path.join(os.tmpdir(),'pablo-v3-'));
const jellyResponse={
 '/Sessions':[{NowPlayingItem:{Id:'1'},UserId:'u1',TranscodingInfo:{VideoCodec:'h264'}},{NowPlayingItem:{Id:'2'},UserId:'u1'},{NowPlayingItem:{Id:'3'},UserId:'u2'},{UserId:'u3'}],
 '/Items/Counts':{MovieCount:432,SeriesCount:22,EpisodeCount:911},
};

test('Jellyfin 12: clés API envoyées par MediaBrowser Authorization',()=>{
 assert.deepEqual(jellyfinAuthHeaders('key123'),{Authorization:'MediaBrowser Token="key123"'});
 assert.throws(()=>jellyfinAuthHeaders('bad\nkey'),/invalide/);
});

test('éditeur: multi-endpoints, compteurs Jellyfin, transformation, ordre et persistance',async()=>{
 const dir=mk(); const requests=[];
 const fetchImpl=async (url,opts)=>{
   const endpoint=new URL(url).pathname;
   requests.push({endpoint,headers:opts.headers});
   return {status:200,ok:true,text:async()=>JSON.stringify(jellyResponse[endpoint])};
 };
 try {
  const integrations=createIntegrationStore({dir,secret,fetchImpl});
  const jelly=integrations.create({name:'Jellyfin Cinema',type:'jellyfin',url:'http://192.168.1.200:8096',secret:'API-KEY-123'});
  const dashboard=createDashboardStore({dir,integrations});
  assert.equal(dashboard.list().cards.length,DEFAULT_CARDS.length);
  const cardId='core-jellyfin';
  const movies=dashboard.rowAction(cardId,'upsert',{label:'Films disponibles',sourceType:'integration',integrationId:jelly.id,endpoint:'/Items/Counts',field:'MovieCount',transform:'value'});
  const series=dashboard.rowAction(cardId,'upsert',{label:'Séries disponibles',sourceType:'integration',integrationId:jelly.id,endpoint:'/Items/Counts',field:'SeriesCount',transform:'value'});
  const playing=dashboard.rowAction(cardId,'upsert',{label:'Sessions en lecture',sourceType:'integration',integrationId:jelly.id,endpoint:'/Sessions',transform:'playingSessions'});
  const users=dashboard.rowAction(cardId,'upsert',{label:'Utilisateurs actifs',sourceType:'integration',integrationId:jelly.id,endpoint:'/Sessions',transform:'activeUsers'});
  const transcodes=dashboard.rowAction(cardId,'upsert',{label:'Transcodages',sourceType:'integration',integrationId:jelly.id,endpoint:'/Sessions',transform:'transcodes'});
  const data=await dashboard.readData({jellyfin:{streams:3,users:2,transcodes:1},radarr:{queue:2},sonarr:{queue:5}});
  const result=data.cards.find(x=>x.id===cardId).rows;
  const value=id=>result.find(x=>x.id===id).value;
  assert.deepEqual([value(movies.id),value(series.id),value(playing.id),value(users.id),value(transcodes.id)],[432,22,3,2,1]);
  assert.equal(requests.length,2,'API requests must be reused across rows with same integration+endpoint');
  assert.equal(requests[0].headers.Authorization,'MediaBrowser Token="API-KEY-123"');
  assert.equal(requests[0].headers['X-Emby-Token'],undefined);
  const preview=await dashboard.previewMetric({label:'Films',sourceType:'integration',integrationId:jelly.id,endpoint:'/Items/Counts',field:'MovieCount'},{});
  assert.deepEqual([preview.ok,preview.value],[true,432]);
  const inspect=await dashboard.inspectApi({integrationId:jelly.id,endpoint:'/Items/Counts'});
  assert.ok(inspect.paths.find(p=>p.path==='MovieCount'));
  assert.ok(!JSON.stringify(inspect).includes('API-KEY-123'),'API key never returned in browser inspector');
  const before=dashboard.list().cards.find(x=>x.id===cardId).rows.map(r=>r.id);
  dashboard.reorderRows(cardId,[movies.id,...before.filter(id=>id!==movies.id)]);
  assert.equal(dashboard.list().cards.find(c=>c.id===cardId).rows[0].id,movies.id);
  const persisted=createDashboardStore({dir,integrations});
  assert.equal(persisted.list().cards.find(c=>c.id===cardId).rows[0].label,'Films disponibles');
  assert.ok(fs.existsSync(path.join(dir,'dashboard.json')));
  assert.ok(!fs.readFileSync(path.join(dir,'dashboard.json'),'utf8').includes('API-KEY-123'));
  assert.deepEqual(METRIC_TEMPLATES.filter(x=>x.type==='jellyfin').map(x=>x.label).slice(3),['Films disponibles','Séries disponibles','Épisodes disponibles']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('cartes: créer, cacher, dupliquer, déplacer, exporter/importer et réinitialiser',async()=>{
 const dir=mk();
 try{
  const i=createIntegrationStore({dir,secret,fetchImpl:async()=>({status:200,ok:true,text:async()=>'{"value":1}'})});
  const d=createDashboardStore({dir,integrations:i});
  const card=d.upsertCard({title:'Réseau',icon:'◇',span:2,url:'http://192.168.1.200:8888'});
  d.upsertCard({id:card.id,title:'Réseau',enabled:false});
  assert.equal(d.list().cards.at(-1).enabled,false);
  assert.equal(d.readData?true:false,true);
  const duplicate=d.duplicateCard(card.id);assert.notEqual(duplicate.id,card.id);
  const ids=d.list().cards.map(c=>c.id);
  d.reorderCards([duplicate.id,...ids.filter(x=>x!==duplicate.id)]);
  assert.equal(d.list().cards[0].id,duplicate.id);
  assert.throws(()=>d.reorderCards([duplicate.id,duplicate.id]),/Ordre invalide/);
  const backup=d.exportLayout();
  d.reset();assert.equal(d.list().cards.length,3);
  d.importLayout(backup);assert.equal(d.list().cards.length,5);
  d.deleteCard(duplicate.id);assert.equal(d.list().cards.length,4);
  assert.throws(()=>d.importLayout({version:2,cards:[{id:'***',title:'bad',rows:[]}]}),/Carte/);
  assert.throws(()=>d.upsertCard({title:'url',url:'javascript:alert(1)'}),/Lien invalide/);
  assert.throws(()=>d.rowAction('core-jellyfin','upsert',{label:'danger',sourceType:'integration',integrationId:'random',endpoint:'/api'}),/Intégration inexistante/);
  assert.throws(()=>d.rowAction('core-jellyfin','upsert',{label:'danger',sourceType:'status',path:'__proto__.hello'}),/Champ JSON invalide/);
  assert.throws(()=>d.rowAction('core-jellyfin','upsert',{label:'danger',sourceType:'status',path:'foo',transform:'eval'}),/Transformation inconnue/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('migration v0.2: conserve les widgets API comme cartes sans exposer les secrets',()=>{
 const dir=mk();
 try{
  const i=createIntegrationStore({dir,secret,fetchImpl:async()=>({status:200,ok:true,text:async()=>'{"count":5}'})});
  const app=i.create({name:'App legacy',type:'custom',url:'http://192.168.1.200:7777',auth:'header',secret:'OLD-SECRET',headerName:'X-Key',endpoint:'/api',field:'count'});
  i.upsertWidget({title:'Ancien widget',integrationId:app.id,field:'count'});
  const d=createDashboardStore({dir,integrations:i});
  assert.equal(d.list().cards.length,4);
  assert.equal(d.list().cards[3].rows[0].integrationId,app.id);
  assert.equal(d.list().cards[3].title,'Ancien widget');
  assert.equal(d.list().cards[3].rows[0].endpoint,'');
  assert.ok(!JSON.stringify(d.list()).includes('OLD-SECRET'));
  d.removeIntegrationReferences(app.id);
  assert.equal(d.list().cards[3].rows.length,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
