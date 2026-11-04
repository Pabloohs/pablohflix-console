import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
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
