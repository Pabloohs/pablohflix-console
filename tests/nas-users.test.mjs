import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import vm from 'node:vm';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pablo-host-accounts-'));
process.env.NODE_ENV='test';
process.env.METRICS_DIR=dir;
process.env.DATA_DIR=dir;
process.env.DASHBOARD_USER='admin';
process.env.DASHBOARD_PASSWORD='test-password-is-long-enough';
process.env.DASHBOARD_SESSION_SECRET='test-secret-012345678901234567890123456789';
const {server,parseNasUsers,readNasUsers}=await import('../server.mjs');

test('NAS accounts: parse sanitized login|UID, classify and reject corrupted rows',()=>{
  const text=[
    'root|0',
    'service|77',
    'member_a|1102',
    'member-b|1001',
    'nobody|65534',
    'member_a|9999',
    'someone|1|PRIVATE:EXTRA',
    'bad user|1000',
    'unix|not-a-number',
    'attacker<script>|1008',
    ''
  ].join('\n');
  const accounts=parseNasUsers(text);
  assert.deepEqual(accounts.map(x=>x.name),['root','service','member-b','member_a','nobody']);
  assert.deepEqual(accounts.map(x=>x.uid),[0,77,1001,1102,65534]);
  assert.deepEqual(accounts.map(x=>x.system),[true,true,false,false,true]);
  assert.doesNotMatch(JSON.stringify(accounts),/PRIVATE|attacker|script|password|home/);
  assert.deepEqual(parseNasUsers(''),[]);
});

test('UGOS collector: only login and numeric UID, no password or home path',()=>{
  execFileSync('sh',['-n','scripts/collect-nas.sh']);
  execFileSync('sh',['scripts/collect-nas.sh'],{
    env:{...process.env,PABLOHFLIX_METRICS_DIR:dir},
    timeout:15000,stdio:'pipe'
  });
  const text=fs.readFileSync(path.join(dir,'users.psv'),'utf8');
  assert.ok(text.includes('root|0'), 'root should be present in local NSS inventory');
  assert.match(text,/^[A-Za-z_][A-Za-z0-9_.-]*\|[0-9]+/m);
  assert.doesNotMatch(text,/:|\/home\/|\/bin\/|\/root\/|password|x\|/i);
  assert.match(fs.readFileSync(path.join(dir,'users.last'),'utf8'),/^\d{10}\n$/);
  const snapshot=readNasUsers();
  assert.equal(snapshot.ok,true);
  assert.ok(snapshot.accounts.some(a=>a.name==='root'&&a.system));
});

test('Host user endpoint requires authenticated session and does not join global status',async()=>{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  try{
    let res=await fetch(base+'/api/system/users');
    assert.equal(res.status,401);
    res=await fetch(base+'/api/login',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:'admin',password:process.env.DASHBOARD_PASSWORD})
    });
    assert.equal(res.status,200);
    const cookie=res.headers.get('set-cookie').split(';')[0];
    res=await fetch(base+'/api/system/users',{headers:{cookie}});
    assert.equal(res.status,200);
    const users=await res.json();
    assert.equal(users.ok,true);
    assert.ok(users.accounts.some(a=>a.name==='root'));
    assert.ok(users.accounts.every(a=>Object.keys(a).sort().join(',')==='name,system,uid'));
    res=await fetch(base+'/api/status',{headers:{cookie}});
    assert.equal(res.status,200);
    const main=await res.json();
    assert.equal(Object.hasOwn(main,'nasUsers'),false);
    assert.equal(Object.hasOwn(main,'accounts'),false);
  }finally{server.close();}
});

test('The System panel includes accessible UID list and a technical-account toggle',()=>{
  const html=fs.readFileSync('public/index.html','utf8');
  assert.match(html,/id="nas-users-panel"/);
  assert.match(html,/id="nas-users-list"/);
  assert.match(html,/id="nas-users-technical-toggle"/);
  assert.match(html,/UTILISATEURS NAS/);
  const source=fs.readFileSync('public/app.js','utf8');
  assert.match(source,/fetch\('\/api\/system\/users'/);
  assert.match(source,/account\.system/);
  assert.match(source,/account\.uid/);
  assert.doesNotMatch(html,/<script\b[^>]*>[\s\S]*?\/api\/system\/users/);
});
