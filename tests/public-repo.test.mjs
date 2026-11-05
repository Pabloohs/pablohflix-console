import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, statSync} from 'node:fs';

// Guardrails for a publicly visible source checkout. Test-only addresses use
// 192.168.56.0/24 or 172.28.99.0/24, not a real NAS deployment network.
const forbiddenPatterns=[
  {name:'Deployment LAN subnet',re:/\b192\.168\.1\.\d{1,3}\b/g},
  {name:'Deployment Tailscale subnet',re:/\b100\.101\.\d{1,3}\.\d{1,3}\b/g},
  {name:'Deployment Recordstudio bridge',re:/\b172\.23\.0\.\d{1,3}\b/g},
  {name:'Deployment-specific filesystem directory',re:/\/volume1\/docker\/(?:nas-dashboard|pablohflix-native-preview|recordstudio)\b/g},
  {name:'Deployment-specific public domain',re:/pablohflix\.duckdns\.(?:org|com)/gi},
  {name:'Deployment hostname',re:/DXP4800PRO-[A-F0-9]{4}/gi},
  {name:'Hard-coded runtime UID/GID',re:/\b10(?:05):100\b/g},
  {name:'GitHub token pattern',re:/\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{40,})\b/g},
  {name:'Possible OpenAI key pattern',re:/\bsk-[A-Za-z0-9_-]{24,}\b/g},
  {name:'Private key content',re:/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g}
];
const localOnlyFiles=[
  /(^|\/)\.env(?:$|\.(?!example$))/,
  /(^|\/)secrets?\//,
  /(^|\/)data\/.*\.(?:json|sqlite|db)$/,
  /\.(?:p12|pfx|pem|key|tgz|bak|sqlite3?|db|psv)$/
];

test('Public repository: no deployment-specific details or secret files in tracked sources',()=>{
  const tracked=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  const findings=[];
  for(const file of tracked){
    if(localOnlyFiles.some(re=>re.test(file))) {
      findings.push('Sensitive or local-only tracked file');
      continue;
    }
    if(!/\.(?:js|mjs|cjs|md|yaml|yml|json|html|sh|css|toml|txt|example)$|^Dockerfile$|^\.gitignore$/.test(file))continue;
    if(statSync(file).size>2_000_000)continue;
    const body=readFileSync(file,'utf8');
    for(const {name,re} of forbiddenPatterns){
      re.lastIndex=0;
      if(re.test(body))findings.push(file+' : '+name);
    }
  }
  assert.deepEqual(findings,[],findings.join('\n'));
});
