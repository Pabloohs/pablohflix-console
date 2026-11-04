import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {summarizeRecordStudio} from '../recordstudio.mjs';
import {createIntegrationStore} from '../integrations.mjs';
import {createDashboardStore} from '../dashboard.mjs';

const sample={
  streamers:[
    {key:'CB:private1',username:'private1',url:'https://example.invalid/1',enabled:true,state:'enregistrement',recordings:10,files:3,total_size:500},
    {key:'CB:private2',username:'private2',enabled:true,state:'hors ligne',recordings:18,files:5,total_size:400},
    {key:'CB:private3',username:'private3',enabled:false,state:'désactivé',recordings:0,files:0,total_size:0},
    {key:'CB:private4',username:'private4',enabled:true,state:'enregistrement',recordings:25,files:4,total_size:300}
  ],
  disk:{free_percent:98.5,free_bytes:12345,total_bytes:45678},
  now:1793703605
};

test('cbrecorder : calcul exact du nombre actif sans divulgation des identités',()=>{
  const data=summarizeRecordStudio(sample);
  assert.deepEqual([data.streams,data.configured,data.enabled,data.errors,data.files,data.recordingsBytes,data.freePercent],
    [2,4,3,0,12,1200,98.5]);
  assert.equal(data.ok,true);
  assert.doesNotMatch(JSON.stringify(data),/private|example\.invalid|recordings":10/);
  assert.equal(summarizeRecordStudio({streamers:[],disk:{free_percent:99},now:1793703605}).streams,0);
  assert.equal(summarizeRecordStudio({streamers:[{state:'erreur (timeout)',enabled:true,files:0,total_size:0}],disk:{},now:1793703605}).errors,1);
});

test('cbrecorder : un schéma invalide ne se transforme jamais en faux zéro',()=>{
  assert.throws(()=>summarizeRecordStudio({status:'running'}),/streamers absent/);
  assert.throws(()=>summarizeRecordStudio({streamers:[{state:null,enabled:true}]}),/incorrects/);
});

test('cbrecorder : HTTP Basic chiffré au repos, carte Stream en cours via statut et preview',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pablo-recordstudio-'));
  const calls=[];
  const fetchImpl=async(url,opts)=>{
    calls.push({url:String(url),headers:opts.headers});
    return {status:200,ok:true,text:async()=>JSON.stringify(sample)};
  };
  try{
    const integrations=createIntegrationStore({dir,secret:'secret-test-sufficiently-long-to-encrypt-recordstudio',fetchImpl});
    const id=integrations.create({
      type:'recordstudio',name:'Recordstudio API',url:'http://172.23.0.2:18080',
      username:'admin',auth:'basic',secret:'RECORDSTUDIO-TEST-ONLY-SECRET',endpoint:'/api/state'
    }).id;
    const checked=await integrations.test(id);
    assert.equal(checked.ok,true);
    assert.equal(checked.metric,2);
    assert.equal(calls[0].headers.Authorization,'Basic '+Buffer.from('admin:RECORDSTUDIO-TEST-ONLY-SECRET').toString('base64'));
    assert.equal(calls[0].url,'http://172.23.0.2:18080/api/state');
    const dashboard=createDashboardStore({dir,integrations});
    const rows=(await dashboard.readData({recordstudio:{ok:true,streams:2}})).cards.find(c=>c.id==='core-recordstudio').rows;
    assert.equal(rows.find(r=>r.id==='record-streams').value,2);
    const preview=await dashboard.previewMetric({
      label:'Streams en cours',sourceType:'integration',integrationId:id,
      endpoint:'/api/state',field:'streams',transform:'value'
    },{});
    assert.equal(preview.ok,true);
    assert.equal(preview.value,2);
    integrations.update(id,{field:'status',secret:''});
    assert.equal((await integrations.test(id)).metric,2,'legacy field is backward-compatible');
    const saved=fs.readFileSync(path.join(dir,'integrations.json'),'utf8');
    assert.doesNotMatch(saved,/RECORDSTUDIO-TEST-ONLY-SECRET|private1/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
