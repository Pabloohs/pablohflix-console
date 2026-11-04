import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPreferenceStore,createFeedReader,parseFeed,downloadFeed,pinnedIpv4Lookup} from '../preferences.mjs';
import net from 'node:net';
import {once} from 'node:events';

const makeDir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'pablo-experience-'));
test('sources RSS, raccourcis, bandeau et VPN sauvegardés et validés',()=>{
  const dir=makeDir();
  try{
    const prefs=createPreferenceStore({dir});
    let config=prefs.read();
    assert.equal(config.feeds.length,1);
    assert.ok(config.quickLinks.length>=9);
    config.feedGroups.push({id:'hardware',name:'Hardware & NAS'});
    config.feeds.push({id:'feed-hardware',groupId:'hardware',name:'Actu NAS',url:'https://example.com/feed.xml',enabled:true});
    config.quickGroups.push({id:'homelab',name:'Homelab'});
    config.quickLinks.push({id:'my-app',groupId:'homelab',name:'Mon app',url:'http://192.168.1.200:9090/'});
    config.overview=['storage','docker','rss'];
    config.vpns.record.expectedCountry='CH';
    config.resourceSources=['api','volume1','rss'];
    prefs.save(config);
    const restored=createPreferenceStore({dir}).read();
    assert.deepEqual(restored,config);
    assert.equal(fs.statSync(path.join(dir,'experience.json')).mode & 0o777,0o600);
    assert.throws(()=>prefs.save({...config,feedGroups:[]}),/minimum|groupe/i);
    assert.throws(()=>prefs.save({...config,feeds:[{id:'bad-feed',name:'Local',groupId:'cyber',url:'http://127.0.0.1:8989'}]}),/HTTPS/i);
    assert.throws(()=>prefs.save({...config,quickLinks:[{id:'danger',name:'danger',groupId:'media',url:'javascript:alert(1)'}]}),/HTTP/i);
    assert.throws(()=>prefs.save({...config,overview:['docker','docker']}),/synthèse/i);
    assert.throws(()=>prefs.save({...config,feeds:[{id:'bad-feed',name:'Bad',groupId:'missing',url:'https://example.com/feed'}]}),/groupe/i);
    assert.deepEqual(prefs.read(),restored);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('RSS 2.0, CDATA, Atom et extraction des liens HTTP(S) sûrs',()=>{
  const rss=`<?xml version="1.0"?><rss version="2.0"><channel><item><title><![CDATA[Alerte &amp; correctif]]></title><link>https://example.org/a</link><pubDate>Tue, 03 Nov 2026 09:00:00 GMT</pubDate></item><item><title>Invalide</title><link>javascript:alert(1)</link></item></channel></rss>`;
  assert.deepEqual(parseFeed(rss).map(x=>x.title),['Alerte & correctif']);
  assert.deepEqual(parseFeed(rss).map(x=>x.link),['https://example.org/a']);
  const atom=`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Update sécurité</title><link rel="alternate" href="https://example.com/story"/><updated>2026-11-04T00:00:00Z</updated></entry></feed>`;
  assert.deepEqual(parseFeed(atom).map(x=>x.title),['Update sécurité']);
  assert.deepEqual(parseFeed(atom).map(x=>x.link),['https://example.com/story']);
  assert.throws(()=>parseFeed('<html>not rss</html>'),/RSS|Atom/);
});

test('RSS : cache, erreurs explicites et conservation des dernières entrées',async()=>{
  const dir=makeDir();let calls=0;
  try{
    const preferences=createPreferenceStore({dir});
    const reader=createFeedReader({preferences,ttlMs:50000,fetchXml:async()=>{calls++;if(calls===1)return '<rss><channel><item><title>Première alerte</title><link>https://example.org/1</link></item></channel></rss>';throw Error('Erreur DNS simulée');}});
    const first=await reader.read();assert.equal(first.items[0].title,'Première alerte');assert.equal(calls,1);
    const cached=await reader.read();assert.equal(cached.items.length,1);assert.equal(calls,1);
    const second=await reader.read({fresh:true});assert.equal(second.feeds[0].ok,false);assert.equal(second.feeds[0].reason,'Erreur DNS simulée');assert.equal(second.items[0].stale,true);
    const issue=await reader.test('http://127.0.0.1/rss.xml').catch(e=>e);
    assert.match(issue.message,/HTTPS/i);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('RSS HTTP client refuse les hôtes privés avant ouverture de connexion',async()=>{
  await assert.rejects(downloadFeed('https://127.0.0.1/rss.xml'),/privé|autorisé/i);
  await assert.rejects(downloadFeed('https://192.168.1.200/rss.xml'),/privé|autorisé/i);
});


test('RSS : DNS pinning compatible avec Node 22 autoSelectFamily (all:true)', async () => {
  const pinned=pinnedIpv4Lookup('127.0.0.1');
  pinned('rss.example',{all:true},(err,addresses)=>{
    assert.equal(err,null);
    assert.deepEqual(addresses,[{address:'127.0.0.1',family:4}]);
  });
  pinned('rss.example',{all:false},(err,ip,family)=>{
    assert.equal(err,null);
    assert.equal(ip,'127.0.0.1');
    assert.equal(family,4);
  });
  const server=net.createServer(socket=>socket.end());
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    const socket=net.connect({
      host:'rss.example',port:server.address().port,autoSelectFamily:true,
      lookup:pinned
    });
    await once(socket,'connect');
    socket.destroy();
  } finally {
    server.close();
  }
});
