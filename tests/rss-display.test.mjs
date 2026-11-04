import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

// Regression: a problem on /api/status must never replace successful RSS articles.
test('Accueil : les actualités RSS survivent à une panne du statut général', async () => {
  const handlers=new Map();
  class Element {
    constructor(tag='div') { this.tagName=tag;this.textContent='';this.children=[];this.className=''; }
    setAttribute() {}
    addEventListener() {}
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children=nodes; }
  }
  const elements=new Map([['news-list',new Element()],['rss-group-tabs',new Element()],['news-status',new Element()],['source-list',new Element()]]);
  const document={getElementById:id=>elements.get(id)||null,createElement:tag=>new Element(tag)};
  const rss={items:[{title:'Avis CERT-FR test indépendant',link:'https://example.org/avis',source:'CERT-FR',groupId:'cyber'}],groups:[{id:'cyber',name:'Cybersécurité'}],feeds:[{ok:true,name:'CERT-FR',count:1}]};
  const fetch=async url=>({status:200,ok:true,json:async()=>url==='/api/rss'?rss:{quickGroups:[],quickLinks:[]}});
  const window={addEventListener:(name,cb)=>handlers.set(name,cb)};
  const script=fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public/experience.js'),'utf8');
  vm.runInNewContext(script,{document,window,fetch,setInterval:()=>{},console,location:{replace:()=>{}}});
  await new Promise(resolve=>setImmediate(resolve));
  const news=elements.get('news-list');
  assert.equal(news.children.length,1);
  assert.equal(news.children[0].children[1].textContent,'Avis CERT-FR test indépendant');
  handlers.get('pablo:status-error')({detail:'HTTP 500'});
  assert.equal(news.children.length,1);
  assert.equal(news.children[0].children[1].textContent,'Avis CERT-FR test indépendant');
  assert.match(elements.get('source-list').children[0].textContent,/Statut général indisponible/);
});
