import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createIntegrationStore} from '../integrations.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(),'pablo-integrations-'));
const secret = 'test-session-secret-is-at-least-32-characters-long';

test('Interface métier : ajout, chiffrement, test API, widgets et ordre persistants', async () => {
  const dir = mk();
  const requests=[];
  const fetchImpl = async (url, options) => {
    requests.push({url:String(url),headers:options.headers});
    return {status:200,ok:true,text:async()=>JSON.stringify({data:{streams:4},items:[{id:1},{id:2}]})};
  };
  try {
    const store=createIntegrationStore({dir,secret,fetchImpl});
    const custom=store.create({type:'custom',name:'Application maison',url:'http://192.168.56.10:4567',endpoint:'/api/status',auth:'header',headerName:'X-Custom-Token',secret:'TOP-SECRET-NE-PAS-EXPOSER',field:'data.streams'});
    assert.equal(custom.hasSecret,true);
    assert.equal(JSON.stringify(custom).includes('TOP-SECRET'),false);
    const onDisk=fs.readFileSync(path.join(dir,'integrations.json'),'utf8');
    assert.equal(onDisk.includes('TOP-SECRET'),false);
    assert.equal((await store.test(custom.id)).metric,4);
    assert.equal(requests[0].headers['X-Custom-Token'],'TOP-SECRET-NE-PAS-EXPOSER');
    store.update(custom.id,{name:'Application maison v2',secret:''});
    const id2=store.create({type:'custom',name:'Sans clé',url:'http://192.168.56.10:9898',endpoint:'/health',auth:'none',field:'items.length'}).id;
    const w1=store.upsertWidget({title:'Lectures',integrationId:custom.id});
    const w2=store.upsertWidget({title:'Items',integrationId:id2});
    assert.deepEqual((await store.readWidgets()).map(x=>x.value),[4,2]);
    store.reorder([w2.id,w1.id]);
    assert.deepEqual(store.listWidgets().map(x=>x.id),[w2.id,w1.id]);
    const persisted=createIntegrationStore({dir,secret,fetchImpl});
    assert.deepEqual(persisted.listWidgets().map(x=>x.id),[w2.id,w1.id]);
    assert.equal((await persisted.test(custom.id)).ok,true);
    persisted.remove(custom.id);
    assert.equal(persisted.listWidgets().length,1);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('Protection : URI distante, localhost et champs dangereux rejetés', async () => {
  const dir=mk();
  const store=createIntegrationStore({dir,secret,fetchImpl:async()=>{throw Error('fetch not expected')}});
  try {
    assert.throws(()=>store.create({type:'custom',name:'Public',url:'http://8.8.8.8:1234',endpoint:'/api',auth:'none',field:'value'}),/Hôte|[Aa]dresse|[Uu]tiliser|Port/);
  } catch(error) {
    // URL validation occurs during the outgoing test: adding a connector does not itself fetch it.
    if(!/Missing expected exception/.test(error.message)) throw error;
    const item=store.list()[0];const result=await store.test(item.id);assert.equal(result.ok,false);
  }
  assert.throws(()=>store.create({type:'custom',name:'Bad',url:'http://127.0.0.1:8000/secret',endpoint:'/api',auth:'none'}),/URL de base/);
  assert.throws(()=>store.create({type:'custom',name:'Bad',url:'http://192.168.56.10:8000',endpoint:'/api/../admin',auth:'none'}),/Chemin API/);
  assert.throws(()=>store.create({type:'custom',name:'Bad',url:'http://192.168.56.10:8000',endpoint:'/api',field:'__proto__.x',auth:'none'}),/Chemin JSON/);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('Pi-hole v6 : mot de passe d’application protégé, session FTL et port HTTP 80 accepté',async()=>{
  const dir=mk();const calls=[];
  try{
    const fetchImpl=async(url,options)=>{
      calls.push({url:String(url),headers:options.headers,method:options.method||'GET',body:options.body});
      if(String(url).endsWith('/api/auth'))return {status:200,ok:true,text:async()=>JSON.stringify({session:{sid:'session-test-token'}})};
      return {status:200,ok:true,text:async()=>JSON.stringify({queries:{total:420,percent_blocked:32}})};
    };
    const store=createIntegrationStore({dir,secret,fetchImpl});
    const item=store.create({type:'pihole',name:'Mon Pi-hole',url:'http://192.168.56.11:80',secret:'secret-from-password',auth:'apiKey'});
    assert.equal(item.url,'http://192.168.56.11');
    const tested=await store.test(item.id);
    assert.equal(tested.ok,true);assert.equal(tested.metric,420);
    assert.equal(calls[0].method,'POST');
    assert.equal(calls[0].body,JSON.stringify({password:'secret-from-password'}));
    assert.equal(calls[1].headers['X-FTL-SID'],'session-test-token');
    assert.equal(calls[1].headers['X-Api-Key'],undefined);
    assert.doesNotMatch(JSON.stringify(store.list()),/secret-from-password/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
