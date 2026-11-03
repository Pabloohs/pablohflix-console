import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pablo-v3-api-'));
process.env.NODE_ENV='test';
process.env.DASHBOARD_USER='admin';
process.env.DASHBOARD_PASSWORD='test-password-over-14-characters';
process.env.DASHBOARD_SESSION_SECRET='test-secret-dashboard-session-long-enough';
process.env.DATA_DIR=dir;
process.env.METRICS_DIR=dir;
const {server}=await import('../server.mjs');

test('HTTP: Settings protégé, cartes et lignes persistantes, actions JSON CSRF',async()=>{
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}`;
 try {
  let r=await fetch(url+'/settings',{redirect:'manual'});
  assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/login');
  r=await fetch(url+'/api/dashboard');assert.equal(r.status,401);
  r=await fetch(url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.DASHBOARD_PASSWORD})});
  assert.equal(r.status,200);
  const cookie=r.headers.get('set-cookie').split(';')[0];
  const opts={headers:{cookie}};
  r=await fetch(url+'/settings',opts);assert.equal(r.status,200);assert.ok((await r.text()).includes('Dashboard &amp; cartes'));
  r=await fetch(url+'/api/catalog',opts);const catalog=await r.json();assert.ok(catalog.metrics.some(x=>x.id==='jelly-movies'));
  r=await fetch(url+'/api/dashboard',opts);assert.equal((await r.json()).cards.length,3);
  r=await fetch(url+'/api/dashboard/cards',{method:'POST',headers:{...opts.headers,'Content-Type':'application/json',Origin:'http://attacker.invalid'},body:JSON.stringify({title:'Evil'})});assert.equal(r.status,403);
  const post=async(path,body)=>{
    const response=await fetch(url+path,{method:'POST',headers:{...opts.headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
  };
  const added=await post('/api/dashboard/cards',{title:'Tests API',icon:'◇',description:'DÉMO',enabled:true,span:1});
  assert.ok(added.item.id);
  const r1=await post(`/api/dashboard/cards/${added.item.id}/rows`,{label:'CPU',sourceType:'status',path:'system.cpu',format:'percent',suffix:'%'});
  assert.equal(r1.item.label,'CPU');
  r=await fetch(url+'/api/dashboard/export',opts);const exportData=await r.json();assert.ok(exportData.cards.find(c=>c.id===added.item.id).rows.find(x=>x.label==='CPU'));
  const preview=await post('/api/dashboard/preview',{label:'Test',sourceType:'status',path:'computed.arrQueue'});assert.equal(preview.ok,false);
  r=await fetch(url+'/integrations',{...opts,redirect:'manual'});assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/settings?tab=integrations');
  const missing=await fetch(url+'/api/dashboard/inspect',{method:'POST',headers:{...opts.headers,'Content-Type':'application/json'},body:JSON.stringify({integrationId:'missing'})});assert.equal(missing.status,400);
  await post(`/api/dashboard/cards/${added.item.id}/delete`,{});
  r=await fetch(url+'/api/dashboard',opts);assert.equal((await r.json()).cards.length,3);
 } finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
});
