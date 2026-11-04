(()=>{'use strict';
const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const x=document.createElement(tag);if(cls)x.className=cls;if(text!==undefined)x.textContent=String(text);return x;};
const button=(text,handler,cls='')=>{const b=el('button','small-button '+cls,text);b.type='button';b.addEventListener('click',handler);return b;};
const uuid=()=>{
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
  return [...b].map((v,i)=>`${[4,6,8,10].includes(i)?'-':''}${v.toString(16).padStart(2,'0')}`).join('');
};
let state=null,integrations=[],overviewOptions=[];
const api=async(url,method='GET',body)=>{const options={method,cache:'no-store',headers:{}};if(body!==undefined){options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}const res=await fetch(url,options);if(res.status===401){location.assign('/login');throw Error('Session expirée');}const data=await res.json();if(!res.ok)throw Error(data.error||`HTTP ${res.status}`);return data;};
const notice=(msg,error=false)=>{const x=$('notice');x.textContent=msg;x.hidden=false;x.className='notice '+(error?'bad':'ok');};
const op=async(fn,success)=>{try{await fn();if(success)notice(success);}catch(e){notice(e.message||String(e),true);}};
async function save(next){state=await api('/api/experience','POST',next);render();}
function reset(formName){const f=$(formName+'-form');f.reset();$(formName+'-id').value='';if(formName==='feed')$('feed-enabled').checked=true;}
const groups=(prefix)=>prefix==='feed'?'feedGroups':'quickGroups';
const listKey=(prefix)=>prefix==='feed'?'feeds':'quickLinks';
const editGroup=(prefix,item)=>{$(prefix+'-group-id').value=item.id;$(prefix+'-group-name').value=item.name;$(prefix+'-group-name').focus();};
async function deleteGroup(prefix,item){
  if(state[listKey(prefix)].some(x=>x.groupId===item.id)){notice('Déplace ou supprime d’abord les éléments de ce groupe.',true);return;}
  if(state[groups(prefix)].length<=1){notice('Il faut conserver au moins un groupe.',true);return;}
  if(!confirm(`Supprimer le groupe « ${item.name} » ?`))return;
  await op(async()=>{const next=structuredClone(state);next[groups(prefix)]=next[groups(prefix)].filter(x=>x.id!==item.id);await save(next);reset(prefix+'-group');},'Groupe supprimé.');
}
async function move(prefix,property,id,offset){
  await op(async()=>{const next=structuredClone(state);const a=next[property],i=a.findIndex(x=>x.id===id),j=i+offset;if(i<0||j<0||j>=a.length)return;[a[i],a[j]]=[a[j],a[i]];await save(next);},'Ordre enregistré.');
}
function renderGroup(prefix){
  const root=$(prefix+'-group-list');root.replaceChildren();
  const array=state[groups(prefix)];
  for(const item of array){
    const row=el('div','config-item'),info=el('div','item-main');info.append(el('span','item-title',item.name));
    const actions=el('div','item-actions');actions.append(button('↑',()=>move(prefix,groups(prefix),item.id,-1)),button('↓',()=>move(prefix,groups(prefix),item.id,+1)),button('Modifier',()=>editGroup(prefix,item)),button('Supprimer',()=>deleteGroup(prefix,item),'danger'));
    row.append(info,actions);root.append(row);
  }
  const select=$(prefix+'-group');const previous=select.value;select.replaceChildren();
  for(const g of array)select.add(new Option(g.name,g.id));
  if(array.some(g=>g.id===previous))select.value=previous;
}
function renderItem(prefix){
  const root=$(prefix+'-list');root.replaceChildren();
  for(const group of state[groups(prefix)]){
    const items=state[listKey(prefix)].filter(x=>x.groupId===group.id);
    if(!items.length)continue;
    root.append(el('h3','managed-heading',group.name));
    for(const item of items){
      const row=el('div','config-item'),info=el('div','item-main'),actions=el('div','item-actions');
      info.append(el('span','item-title',item.name),el('span','item-meta',item.url));
      if(prefix==='feed')info.append(el('span','item-meta',item.enabled?'● Activé':'◯ Désactivé'));
      actions.append(button('↑',()=>move(prefix,listKey(prefix),item.id,-1)),button('↓',()=>move(prefix,listKey(prefix),item.id,1)),button('Modifier',()=>editItem(prefix,item)),button('Supprimer',()=>deleteItem(prefix,item),'danger'));
      row.append(info,actions);root.append(row);
    }
  }
  if(!state[listKey(prefix)].length)root.append(el('p','muted',prefix==='feed'?'Aucun flux configuré.':'Aucun accès rapide configuré.'));
}
function editItem(prefix,item){
  $(prefix+'-id').value=item.id;
  $(prefix+'-name').value=item.name;
  $(prefix+'-url').value=item.url;
  $(prefix+'-group').value=item.groupId;
  if(prefix==='feed')$('feed-enabled').checked=item.enabled;
  $(prefix+'-name').focus();
  $(prefix+'-form').scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function deleteItem(prefix,item){
  if(!confirm(`Supprimer « ${item.name} » ?`))return;
  await op(async()=>{const next=structuredClone(state);next[listKey(prefix)]=next[listKey(prefix)].filter(x=>x.id!==item.id);await save(next);reset(prefix);},'Élément supprimé.');
}
for(const prefix of ['feed','shortcut']){
  $(prefix+'-group-new').addEventListener('click',()=>reset(prefix+'-group'));
  $(prefix+'-new').addEventListener('click',()=>reset(prefix));
  $(prefix+'-group-form').addEventListener('submit',async e=>{
    e.preventDefault();await op(async()=>{
      const next=structuredClone(state),key=groups(prefix),id=$(prefix+'-group-id').value||uuid();
      const obj={id,name:$(prefix+'-group-name').value},at=next[key].findIndex(x=>x.id===id);
      if(at>=0)next[key][at]=obj;else next[key].push(obj);
      await save(next);reset(prefix+'-group');
    },'Groupe enregistré.');
  });
  $(prefix+'-form').addEventListener('submit',async e=>{
    e.preventDefault();await op(async()=>{
      const next=structuredClone(state),key=listKey(prefix),id=$(prefix+'-id').value||uuid();
      const obj={id,name:$(prefix+'-name').value,url:$(prefix+'-url').value,groupId:$(prefix+'-group').value};
      if(prefix==='feed')obj.enabled=$('feed-enabled').checked;
      const at=next[key].findIndex(x=>x.id===id);if(at>=0)next[key][at]=obj;else next[key].push(obj);
      await save(next);reset(prefix);
    },prefix==='feed'?'Flux enregistré.':'Accès rapide enregistré.');
  });
}
$('feed-test').addEventListener('click',async()=>{
  const root=$('feed-test-result');root.hidden=false;root.className='inline-preview';root.textContent='Test HTTPS en cours…';
  try{
    const result=await api('/api/rss/test','POST',{url:$('feed-url').value});
    if(!result.ok){root.className='inline-preview bad';root.textContent='● '+result.reason;}
    else root.textContent=`✓ ${result.items.length} articles affichés en aperçu · ${result.items.map(x=>x.title).join(' · ').slice(0,220)}`;
  }catch(e){root.className='inline-preview bad';root.textContent=String(e.message||e);}
});
function renderOverview(){
  const root=$('overview-selects');root.replaceChildren();
  for(let i=0;i<4;i++){
    const label=el('label','',`Position ${i+1}`),select=el('select','');select.dataset.position=i;
    select.append(new Option('— Aucun indicateur —',''));
    for(const opt of overviewOptions)select.add(new Option(opt.name,opt.id));
    select.value=state.overview[i]||'';root.append(label,select);
  }
}
$('overview-form').addEventListener('submit',async e=>{
  e.preventDefault();await op(async()=>{
    const next=structuredClone(state);next.overview=[...document.querySelectorAll('#overview-selects select')].map(x=>x.value).filter(Boolean);await save(next);
  },'Bandeau supérieur enregistré.');
});
function renderVpn(){
  for(const [key,prefix] of [['media','vpn-media'],['record','vpn-record']]){
    const select=$(prefix+'-integration'),existing=state.vpns[key].integrationId;
    select.replaceChildren(new Option('— Non configuré —',''));
    // Gluetun presets plus custom REST JSON integrations are supported.
    for(const x of integrations.filter(x=>x.type==='gluetun'||x.type==='custom'))select.add(new Option(x.name+' · '+x.type,x.id));
    select.value=[...select.options].some(x=>x.value===existing)?existing:'';
    $(prefix+'-country').value=state.vpns[key].expectedCountry;
  }
}
$('vpn-source-form').addEventListener('submit',async e=>{
  e.preventDefault();await op(async()=>{
    const next=structuredClone(state);
    for(const key of ['media','record'])next.vpns[key]={integrationId:$('vpn-'+key+'-integration').value,expectedCountry:$('vpn-'+key+'-country').value.toUpperCase()};
    await save(next);await loadDiagnostics();
  },'Sources VPN enregistrées.');
});
function render(){
  if(!state)return;
  for(const prefix of ['feed','shortcut']){renderGroup(prefix);renderItem(prefix);}
  renderOverview();renderVpn();
}
let knownSources=[];
function renderResourcePicker(){
  const root=$('resource-source-list');root.replaceChildren();
  const preferred=state?.resourceSources||[];
  const ordered=[...preferred.map(id=>knownSources.find(x=>x.id===id)).filter(Boolean),...knownSources.filter(x=>!preferred.includes(x.id))];
  for(const item of ordered){
    const row=el('div','config-item'),main=el('div','item-main');
    const label=el('label','check-label'),checkbox=el('input','');checkbox.type='checkbox';checkbox.checked=preferred.includes(item.id);checkbox.dataset.sourceId=item.id;
    label.append(checkbox,el('span','',item.label));main.append(label);
    const actions=el('div','item-actions');const up=button('↑',()=>row.previousElementSibling?.before(row));const down=button('↓',()=>row.nextElementSibling?.after(row));actions.append(up,down);row.append(main,actions);root.append(row);
  }
}
$('save-resources').addEventListener('click',async()=>{await op(async()=>{const next=structuredClone(state);next.resourceSources=[...document.querySelectorAll('#resource-source-list input:checked')].map(x=>x.dataset.sourceId);await save(next);},'État des sources personnalisé.');});
async function renderSetupSummary(){
  const root=$('setup-overview');if(!root)return;
  try{
    const diag=await api('/api/setup/diagnostics');root.replaceChildren();
    const targets=diag.sources.filter(x=>['docker','volume1','volume2','smart','jellyfin','rss','vpnrecord'].includes(x.id));
    const good=targets.filter(x=>x.kind==='ready').length;
    root.append(el('p','hint',`${good}/${targets.length} sources opérationnelles. Cliquez sur une source pour voir comment la configurer.`));
    for(const item of targets){const a=el('a','setup-summary-item',`${item.kind==='ready'?'✓':'⚙'} ${item.label} — ${item.kind==='ready'?'Disponible':item.summary}`);a.href='/settings?tab=sources#'+item.id;root.append(a);}
  }catch(e){root.replaceChildren(el('p','bad-text','Diagnostic indisponible : '+e.message));}
}
async function loadDiagnostics(){
  const root=$('source-diagnostics');root.replaceChildren(el('p','muted','Vérification des API, volumes et inventaires…'));
  try{
    const info=await api('/api/setup/diagnostics');knownSources=info.sources||[];renderResourcePicker();root.replaceChildren();
    for(const item of info.sources||[]){
      const card=el('details','diagnostic-item');card.id=item.id;
      const heading=el('summary','diagnostic-heading');heading.append(el('strong','',item.label));
      const texts={ready:'● Connecté',partial:'◐ Partiel',stale:'◷ Périmé',error:'! Erreur',missing:'⚙ À configurer'};
      heading.append(el('span','source-'+item.kind,texts[item.kind]||item.kind));card.append(heading);
      const content=el('div','diagnostic-body');content.append(el('p','',item.summary));
      if(item.steps?.length){const ul=el('ul','');for(const step of item.steps)ul.append(el('li','',step));content.append(ul);}
      if(item.tab && item.tab!=='sources'){
        const link=el('a','ui-button ui-outline','Ouvrir '+(item.tab==='integrations'?'les intégrations':'les flux RSS'));
        link.href=`/settings?tab=${item.tab}`;content.append(link);
      }
      card.append(content);root.append(card);
    }
    if(location.hash){const anchor=document.getElementById(location.hash.slice(1));if(anchor?.classList.contains('diagnostic-item')){anchor.open=true;anchor.scrollIntoView({block:'center'});}}
  }catch(e){root.replaceChildren(el('p','bad-text','Diagnostic indisponible : '+e.message));}
}
$('check-sources').addEventListener('click',()=>{loadDiagnostics();renderSetupSummary();});
window.addEventListener('pablo:show-sources',loadDiagnostics);
$('export-experience').addEventListener('click',async()=>{await op(async()=>{const config=await api('/api/experience');const url=URL.createObjectURL(new Blob([JSON.stringify(config,null,2)],{type:'application/json'}));const link=el('a','');link.href=url;link.download='pablohflix-sources-et-raccourcis.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},'Export des sources prêt.');});
$('import-experience').addEventListener('click',async()=>{const file=$('import-experience-file').files?.[0];if(!file)return notice('Sélectionne un fichier JSON.',true);if(file.size>110000)return notice('Fichier trop volumineux.',true);if(!confirm('Remplacer les flux, raccourcis, sources et bandeau par ce fichier ?'))return;await op(async()=>{await save(JSON.parse(await file.text()));},'Configuration des sources importée.');});
(async()=>{
  try{
    [state,integrations,{options:overviewOptions}]=await Promise.all([api('/api/experience'),api('/api/integrations').then(x=>x.items),api('/api/overview/options')]);
    render();
    renderSetupSummary();
    if(new URLSearchParams(location.search).get('tab')==='sources')loadDiagnostics();
  }catch(e){notice('Configuration des sources indisponible : '+e.message,true);}
})();
})();
