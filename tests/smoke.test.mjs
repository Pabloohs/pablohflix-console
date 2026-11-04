import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import vm from 'node:vm';
process.env.NODE_ENV='test';
process.env.DASHBOARD_USER='admin';
process.env.DASHBOARD_PASSWORD='test-password-is-long-enough';
process.env.DASHBOARD_SESSION_SECRET='test-secret-012345678901234567890123456789';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pablo-test-'));
process.env.METRICS_DIR=dir;
const {server,collectSnapshot,safeEqual,decodeXml,parseSmartDisks,readVpnFromIntegration}=await import('../server.mjs');

test('comparaison protégée et nettoyage XML',()=>{
  assert.equal(safeEqual('abcdef','abcdef'),true);
  assert.equal(safeEqual('abcdef','abcdefg'),false);
  assert.equal(decodeXml('<![CDATA[Bonjour]]> &amp; &lt;OK&gt;'), 'Bonjour & <OK>');
});

test('collecteur : inconnu si aucun fichier, valeurs réelles si inventaire disponible',()=>{
  assert.equal(collectSnapshot().docker.ok,false);
  fs.writeFileSync(path.join(dir,'updated_at'),new Date().toISOString());
  fs.writeFileSync(path.join(dir,'docker.psv'),'jellyfin|running|Up 2 days (healthy)\nold|exited|Exited (0)\n');
  fs.writeFileSync(path.join(dir,'volumes.df'),'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/a 1000 300 700 30% /volume1\n/dev/b 2000 500 1500 25% /volume2\n');
  fs.writeFileSync(path.join(dir,'disks.psv'),'sda|EXOS|6T|PASSED|38\nsdb|EXOS|6T|UNKNOWN|\n');
  const data=collectSnapshot();
  assert.deepEqual([data.docker.total,data.docker.up,data.docker.down],[2,1,1]);
  assert.equal(data.volumes.volume2.freePercent,75);
  assert.equal(data.disks[1].health,'UNKNOWN');
});

test('authentification, session et API sécurisées',async()=>{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    let r=await fetch(base+'/api/status');assert.equal(r.status,401);
    r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'incorrect'})});assert.equal(r.status,401);
    r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.DASHBOARD_PASSWORD})});assert.equal(r.status,200);
    const sess=r.headers.get('set-cookie').split(';')[0];assert.ok(sess.includes('pablo_session='));
    r=await fetch(base+'/api/status',{headers:{cookie:sess}});assert.equal(r.status,200);
    const data=await r.json();assert.equal(data.docker.total,2);assert.equal(data.jellyfin.ok,false);
    r=await fetch(base+'/api/logout',{method:'POST',headers:{cookie:sess}});assert.equal(r.status,200);
    r=await fetch(base+'/api/status',{headers:{cookie:sess}});assert.equal(r.status,401);
  }finally{server.close();}
});


test('Libellé système : ne présente plus les métriques disponibles comme non confirmées', () => {
  const html=fs.readFileSync(path.join(import.meta.dirname,'../public/index.html'),'utf8');
  assert.match(html,/Mesures système du NAS · actualisation toutes les 30 s/);
  assert.doesNotMatch(html,/hôte à confirmer/);
});


test('SMART : zram exclu, modèles physiques et NVMe complets',()=>{
  const input=[
    'sda|ST6000NM021A-2R7101|5.5T|PASSED|42',
    'sdb|ST6000NM021A-2R7101|5.5T|PASSED|38',
    'sdc|ST6000NM021A-2R7101|5.5T|PASSED|40',
    'sdd|ST33000651NS|2.7T|PASSED|36',
    'zram0||3.9G|UNKNOWN|',
    'zram1||3.9G|UNKNOWN|',
    'zram2||3.9G|UNKNOWN|',
    'zram3||3.9G|UNKNOWN|',
    'nvme0n1|AirDisk 128GB SSD|119G|PASSED|39',
  ].join('\n');
  const disks=parseSmartDisks(input);
  assert.deepEqual(disks.map(x=>x.device),['sda','sdb','sdc','sdd','nvme0n1']);
  assert.equal(disks.at(-1).model,'AirDisk 128GB SSD');
  assert.equal(disks.at(-1).tempC,39);
  const css=fs.readFileSync(path.join(import.meta.dirname,'../public/style.css'),'utf8');
  assert.match(css,/\.diskrow span\{[^}]*white-space:normal/);
});


test('VPN Gluetun : statut visible même si le second endpoint IP est refusé',async()=>{
  const fake={queryData:async(_id,endpoint)=>{
    if(endpoint==='/v1/vpn/status')return {status:'running'};
    throw Error('API HTTP 403');
  }};
  const result=await readVpnFromIntegration(fake,'media-id','CH');
  assert.equal(result.ok,true);
  assert.equal(result.state,'running');
  assert.equal(result.partial,true);
  assert.equal(result.match,null);
  assert.equal(result.ip,null);
  assert.match(result.reason,/403/);
});

test('VPN Gluetun : pays vérifié quand la source le retourne',async()=>{
  const fake={queryData:async(_id,endpoint)=>{
    if(endpoint==='/v1/vpn/status')return {status:'running'};
    return {public_ip:'198.19.0.1',country_code:'CH'};
  }};
  const result=await readVpnFromIntegration(fake,'record-id','CH');
  assert.equal(result.ok,true);
  assert.equal(result.partial,false);
  assert.equal(result.match,true);
  assert.equal(result.country,'CH');
});

test('VPN Gluetun : endpoint statut inaccessible reste en erreur',async()=>{
  const fake={queryData:async(_id,endpoint)=>{
    if(endpoint==='/v1/vpn/status')throw Error('API HTTP 401');
    return {public_ip:'198.19.0.1'};
  }};
  const result=await readVpnFromIntegration(fake,'record-id','CH');
  assert.equal(result.ok,false);
  assert.equal(result.configured,true);
  assert.match(result.reason,/401/);
});


test('Rendu accueil : aucune erreur lorsque les APIs sont disponibles',async()=>{
  const nodes=new Map(),errors=[],events=[];
  const element=id=>{
    if(!nodes.has(id))nodes.set(id,{
      textContent:'',className:'',title:'',value:'',style:{},dataset:{},
      children:[],replaceChildren(...parts){this.children=parts;},
      append(...parts){this.children.push(...parts);},
      addEventListener(){},setAttribute(){}
    });
    return nodes.get(id);
  };
  const data={
    timestamp:'2026-11-04T04:30:00Z',
    system:{cpu:10,ram:25,uptimeSeconds:7200},
    docker:{ok:true,up:12,total:12,unhealthy:0},
    disks:[],
    volumes:{volume1:{totalBytes:1000000,freeBytes:200000,usedPercent:80},
      volume2:{totalBytes:1000000,freeBytes:990000,usedPercent:1,freePercent:99}},
    jellyfin:{ok:true,streams:0,transcodes:0,users:0},
    radarr:{ok:true,queue:0,missing:0},
    sonarr:{ok:true,queue:0,missing:0},
    seerr:{ok:true,pending:0},
    vpnMedia:{ok:true,state:'running',country:'FR'},
    vpnRecord:{ok:true,state:'running',country:null,partial:true,
      configured:true,reason:'Pays de sortie non vérifiable via l’API'}
  };
  const context={
    document:{
      body:{dataset:{}},
      getElementById:id=>id==='login-form'?null:element(id),
      createElement:tag=>element('created-'+tag)
    },
    localStorage:{getItem:()=>null,setItem(){}},
    window:{dispatchEvent:e=>events.push(e),addEventListener(){}},
    CustomEvent:class {constructor(type,opts){this.type=type;this.detail=opts.detail;}},
    fetch:async()=>({ok:true,status:200,json:async()=>data}),
    setInterval(){},
    console:{error:e=>errors.push(e)}
  };
  vm.runInNewContext(fs.readFileSync(path.join(import.meta.dirname,'../public/app.js'),'utf8'),
    context,{filename:'public/app.js'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(element('global-state').textContent,'● SUPERVISION ACTIVE');
  assert.equal(element('vpn-media-state').textContent,'RUNNING');
  assert.equal(element('vpn-record-state').textContent,'RUNNING');
  assert.equal(events.some(e=>e.type==='pablo:status'),true);
  assert.deepEqual(errors,[]);
});


test('Les cartes signalent les métriques partielles sans déclarer le service actif',async()=>{
  const elems=new Map();
  const make=tag=>({
    tag,textContent:'',className:'',title:'',dataset:{},children:[],style:{},
    append(...nodes){this.children.push(...nodes);},
    replaceChildren(...nodes){this.children=nodes;},
    addEventListener(){},
    setAttribute(){}
  });
  const get=id=>{
    if(!elems.has(id))elems.set(id,make(id));
    return elems.get(id);
  };
  const document={
    getElementById:id=>id==='toggle-dashboard-edit'?null:get(id),
    createElement:make
  };
  const card={id:'recordstudio',title:'RECORDSTUDIO',span:1,icon:'◉',
    description:'CAPTURE VIDÉO',url:'',
    rows:[
      {id:'a',label:'Streams en cours',ok:false,value:null},
      {id:'b',label:'Stockage libre V2',ok:true,value:99,suffix:'%',format:'percent'},
      {id:'c',label:'VPN Suisse',ok:false,value:null}
    ]
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(import.meta.dirname,'../public/dashboard-cards.js'),'utf8'),
    {document,fetch:async()=>({ok:true,status:200,json:async()=>({cards:[card]})}),
      setInterval(){},Intl},{filename:'public/dashboard-cards.js'}
  );
  await new Promise(resolve=>setImmediate(resolve));
  const grid=get('dashboard-cards');
  assert.equal(grid.children.length,1);
  const badge=grid.children[0].children[0].children.at(-1);
  assert.equal(badge.textContent,'◐ PARTIEL');
  assert.match(badge.title,/1\/3 indicateurs/);
});
