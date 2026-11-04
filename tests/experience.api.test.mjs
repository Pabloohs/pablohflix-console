import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pablo-experience-http-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=directory;
process.env.DASHBOARD_USER='admin';
process.env.DASHBOARD_PASSWORD='strong-test-password-1234';
process.env.DASHBOARD_SESSION_SECRET='test-secret-012345678901234567890123456789';
const {server}=await import('../server.mjs');
test('API : session, modification des groupes, diagnostics et sources protégés', async()=>{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const req=(route,options={})=>fetch(base+route,options);
  try{
    let r=await req('/api/experience');assert.equal(r.status,401);
    r=await req('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.DASHBOARD_PASSWORD})});
    assert.equal(r.status,200);
    const cookie=r.headers.get('set-cookie').split(';')[0];
    const headers={cookie,'Content-Type':'application/json'};
    r=await req('/api/experience',{headers});assert.equal(r.status,200);const config=await r.json();
    config.quickGroups.push({id:'mon-groupe',name:'Nouveau groupe'});
    config.quickLinks.push({id:'mon-lien',name:'Ma Cave',groupId:'mon-groupe',url:'http://192.168.1.200:3010'});
    r=await req('/api/experience',{method:'POST',headers,body:JSON.stringify(config)});assert.equal(r.status,200);
    const saved=await r.json();assert.equal(saved.quickLinks.at(-1).name,'Ma Cave');
    // RSS must be available via its own endpoint, regardless of the media/NAS status.
    saved.feeds=[];
    r=await req('/api/experience',{method:'POST',headers,body:JSON.stringify(saved)});assert.equal(r.status,200);
    r=await req('/api/rss',{headers});assert.equal(r.status,200);
    const rss=await r.json();assert.deepEqual(rss.items,[]);assert.deepEqual(rss.feeds,[]);assert.ok(Array.isArray(rss.groups));
    r=await req('/api/experience',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:JSON.stringify(config)});assert.equal(r.status,403);
    r=await req('/api/setup/diagnostics',{headers});assert.equal(r.status,200);
    const diagnostics=await r.json();
    assert.ok(diagnostics.sources.some(x=>x.id==='docker'&&['missing','stale'].includes(x.kind)));
    assert.ok(diagnostics.sources.some(x=>x.id==='smart'&&x.kind==='missing'));
    assert.ok(diagnostics.sources.some(x=>x.id==='rss'));
    r=await req('/api/overview/options',{headers});assert.equal(r.status,200);assert.ok((await r.json()).options.length>=5);
    r=await req('/settings',{headers});assert.equal(r.status,200);assert.match(await r.text(),/Flux RSS &amp; groupes/);
  }finally{server.close();fs.rmSync(directory,{recursive:true,force:true});}
});
