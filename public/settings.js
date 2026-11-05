(()=>{'use strict';
const $=id=>document.getElementById(id);
const node=(tag,cls,content)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(content!==undefined)e.textContent=String(content);return e;};
const small=(label,fn,extra='')=>{const b=node('button','small-button '+extra,label);b.type='button';b.addEventListener('click',fn);return b;};
const validTabs=['home','dashboard','integrations','feeds','shortcuts','overview','sources','metrics','appearance','backup','diagnostics'];
const themes=['terminal','matrix','midnight','minimal'];
let tab='home', catalog=[],templates=[],integrations=[],cards=[],selectedCardId=null,selectedRowId=null,editingIntegrationId=null;
const notify=(message,bad=false)=>{const el=$('notice');el.hidden=false;el.className='notice '+(bad?'bad':'ok');el.textContent=message;el.scrollIntoView({behavior:'smooth',block:'nearest'});};
const clearNotice=()=>{$('notice').hidden=true;};
const api=async(uri,method='GET',body)=>{
  const options={method,cache:'no-store',headers:{}};
  if(body!==undefined){options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
  const r=await fetch(uri,options);
  if(r.status===401){location.replace('/login');throw Error('Session expirée');}
  const result=await r.json();
  if(!r.ok)throw Error(result.error||`HTTP ${r.status}`);
  return result;
};
const action=async(fn,success)=>{try{await fn();if(success)notify(success);}catch(e){notify(e.message||String(e),true);}};
const integrationById=id=>integrations.find(x=>x.id===id);
const cardById=id=>cards.find(x=>x.id===id);
const selectedCard=()=>cardById(selectedCardId);
const syncTheme=choice=>{const v=themes.includes(choice)?choice:'terminal';document.body.dataset.theme=v;$('theme').value=v;localStorage.setItem('pablo-theme',v);document.querySelectorAll('[data-theme-choice]').forEach(e=>e.classList.toggle('active',e.dataset.themeChoice===v));};
syncTheme(localStorage.getItem('pablo-theme'));
$('theme').addEventListener('change',e=>syncTheme(e.target.value));
document.querySelectorAll('[data-theme-choice]').forEach(el=>el.addEventListener('click',()=>syncTheme(el.dataset.themeChoice)));
$('logout').addEventListener('click',async()=>{await fetch('/api/logout',{method:'POST'});location.assign('/login');});
function showTab(next,updateUrl=true){
  tab=validTabs.includes(next)?next:'home';
  for(const t of validTabs){$('tab-'+t).hidden=tab!==t;}
  document.querySelectorAll('.settings-nav').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tab);b.setAttribute('aria-current',b.dataset.tab===tab?'page':'false');});
  if(updateUrl){const url=new URL(location.href);url.searchParams.set('tab',tab);url.searchParams.delete('card');history.replaceState(null,'',url);}
  if(tab==='diagnostics')renderDiagnostics();
  if(tab==='sources')window.dispatchEvent(new Event('pablo:show-sources'));
}
document.querySelectorAll('.settings-nav').forEach(b=>b.addEventListener('click',()=>{clearNotice();showTab(b.dataset.tab);}));
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>showTab(b.dataset.go)));
const options=(el,data,makeValue,makeLabel,placeholder)=>{
  const previous=el.value;el.replaceChildren();
  if(placeholder)el.add(new Option(placeholder,''));
  for(const entry of data)el.add(new Option(makeLabel(entry),makeValue(entry)));
  if([...el.options].some(o=>o.value===previous))el.value=previous;
};
async function refreshAll(){
  const [catalogResponse,connections,layout]=await Promise.all([api('/api/catalog'),api('/api/integrations'),api('/api/dashboard')]);
  catalog=catalogResponse.presets||[];templates=catalogResponse.metrics||[];integrations=connections.items||[];cards=layout.cards||[];
  $('summary-integrations').textContent=integrations.length;
  $('summary-cards').textContent=cards.length;
  $('summary-rows').textContent=cards.reduce((sum,c)=>sum+c.rows.length,0);
  options($('integration-type'),catalog,x=>x.type,x=>x.label);
  options($('row-integration'),integrations,x=>x.id,x=>x.name+' · '+x.type,'Choisir une intégration');
  renderConnections();renderCards();renderCatalog();renderRows();
  if(selectedCardId&&!cardById(selectedCardId)){selectedCardId=null;selectedRowId=null;$('card-editor').hidden=true;$('row-editor').hidden=true;}
}
// INTEGRATIONS
const currentPreset=()=>catalog.find(x=>x.type===$('integration-type').value)||catalog[0];
function syncAuth(){
  const auth=$('integration-auth').value;
  $('secret-wrap').hidden=auth==='none';$('username-wrap').hidden=auth!=='basic';$('header-wrap').hidden=auth!=='header';
}
function choosePreset(){
  const preset=currentPreset();if(!preset)return;
  const dns={jellyfin:'jellyfin',radarr:'radarr',sonarr:'sonarr',seerr:'seerr',prowlarr:'prowlarr',bazarr:'bazarr',pihole:'pihole'};
  $('integration-name').value=preset.label;
  $('integration-url').value=preset.port?`http://${dns[preset.type]||window.location.hostname}:${preset.port}`:'';
  $('integration-endpoint').value=preset.endpoint;$('integration-field').value=preset.field;
  $('integration-auth').value=preset.auth;$('integration-header').value='X-Api-Key';$('integration-username').value='';$('integration-secret').value='';$('secret-hint').textContent='';syncAuth();
}
function resetIntegration(){editingIntegrationId=null;$('integration-form').reset();$('form-title').textContent='Nouvelle intégration';$('integration-type').disabled=false;choosePreset();}
function editIntegration(item){
  editingIntegrationId=item.id;showTab('integrations');$('form-title').textContent='Modifier · '+item.name;
  $('integration-type').value=item.type;$('integration-type').disabled=true;
  $('integration-name').value=item.name;$('integration-url').value=item.url;$('integration-endpoint').value=item.endpoint;$('integration-field').value=item.field;
  $('integration-auth').value=item.auth;$('integration-secret').value='';$('integration-username').value='';$('integration-header').value=item.customHeader||'X-Api-Key';
  $('secret-hint').textContent=item.hasSecret?'(déjà enregistrée — laisser vide pour conserver)':'';
  syncAuth();document.querySelector('.editor-card').scrollIntoView({behavior:'smooth',block:'start'});
}
function renderConnections(){
  const root=$('integration-list');root.replaceChildren();
  if(!integrations.length){root.append(node('p','empty-state','Aucune intégration. Ajoute Jellyfin, Radarr ou une API personnalisée pour commencer.'));return;}
  for(const item of integrations){
    const el=node('div','integration-item');const left=node('div'),right=node('div','connection-state','● Non testée');
    left.append(node('p','integration-name',item.name),node('small','integration-kind',item.type.toUpperCase()),node('div','integration-url',item.url));
    const buttons=node('div','integration-actions');
    buttons.append(small('Tester',async()=>{
      right.textContent='◌ Test en cours';right.className='connection-state';
      try{const r=await api(`/api/integrations/${item.id}/test`,'POST');right.className='connection-state '+(r.ok?'ok':'bad');right.textContent=r.ok?`● Connectée${r.metric!==null&&r.metric!==undefined?' · '+r.metric:''}`:'● '+(r.reason||'Erreur');}
      catch(e){right.className='connection-state bad';right.textContent=e.message;}
    }),small('Modifier',()=>editIntegration(item)),small('Supprimer',async()=>{
      if(!confirm(`Supprimer ${item.name} ? Les indicateurs qui utilisent cette intégration seront retirés.`))return;
      await action(async()=>{await api(`/api/integrations/${item.id}/delete`,'POST');if(editingIntegrationId===item.id)resetIntegration();await refreshAll();},'Intégration supprimée.');
    },'danger'));
    left.append(buttons);el.append(left,right);root.append(el);
  }
}
$('integration-type').addEventListener('change',choosePreset);$('integration-auth').addEventListener('change',syncAuth);
$('new-integration').addEventListener('click',resetIntegration);$('reset-integration').addEventListener('click',resetIntegration);
$('integration-form').addEventListener('submit',async e=>{
  e.preventDefault();const save=$('save-integration');save.disabled=true;
  const body={type:$('integration-type').value,name:$('integration-name').value,url:$('integration-url').value,auth:$('integration-auth').value,endpoint:$('integration-endpoint').value,field:$('integration-field').value,headerName:$('integration-header').value,username:$('integration-username').value,secret:$('integration-secret').value};
  await action(async()=>{
    const r=await api(editingIntegrationId?`/api/integrations/${editingIntegrationId}/update`:'/api/integrations','POST',body);
    const test=await api(`/api/integrations/${r.item.id}/test`,'POST');
    await refreshAll();resetIntegration();
    notify(test.ok?`${body.name} connecté(e) · tu peux créer des lignes utilisant plusieurs endpoints.`:`${body.name} enregistré(e), mais le test a échoué : ${test.reason||'Connexion impossible'}`,!test.ok);
  });save.disabled=false;
});
// CARDS
const summaryRow=r=>(r.sourceType==='integration'?(integrationById(r.integrationId)?.name||'API absente')+' · '+(r.endpoint||'Endpoint standard')+(r.field?' → '+r.field:''):'Interne · '+r.path);
function draggable(item,id,kind){
  item.draggable=true;item.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain',`${kind}:${id}`);e.dataTransfer.effectAllowed='move';item.classList.add('is-dragging');});
  item.addEventListener('dragend',()=>item.classList.remove('is-dragging'));
  item.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('text/plain'))e.preventDefault();});
  item.addEventListener('drop',async e=>{
    e.preventDefault();const source=e.dataTransfer.getData('text/plain');
    if(!source.startsWith(kind+':'))return;
    const from=source.slice(kind.length+1);if(from===id)return;
    await action(async()=>{await moveItem(kind,from,id);await refreshAll();},'Ordre enregistré.');
  });
}
async function moveItem(kind,from,to){
  const items=kind==='card'?cards:(selectedCard()?.rows||[]);
  const ids=items.map(x=>x.id);const a=ids.indexOf(from),b=ids.indexOf(to);
  if(a<0||b<0||a===b)return;
  ids.splice(b,0,ids.splice(a,1)[0]);
  if(kind==='card')await api('/api/dashboard/cards/reorder','POST',{ids});
  else await api(`/api/dashboard/cards/${selectedCardId}/rows/reorder`,'POST',{ids});
}
async function shift(kind,id,offset){
  const items=kind==='card'?cards:(selectedCard()?.rows||[]);const idx=items.findIndex(x=>x.id===id),target=idx+offset;
  if(idx<0||target<0||target>=items.length)return;
  await action(async()=>{await moveItem(kind,id,items[target].id);await refreshAll();},'Ordre enregistré.');
}
function renderCards(){
  const root=$('card-list');root.replaceChildren();
  if(!cards.length)root.append(node('div','empty-state','Aucune carte. Clique sur « Nouvelle carte » pour commencer.'));
  for(const c of cards){
    const item=node('div','config-item'+(selectedCardId===c.id?' active':''));
    const grab=node('span','drag-handle','⠿');grab.title='Glisser pour réordonner';
    const main=node('div','item-main');main.append(node('span','item-title',(c.icon||'◇')+' '+c.title),node('span','item-meta',`${c.rows.length} ligne(s) · ${c.enabled?'visible':'masquée'} · largeur ${c.span}`));
    const actions=node('div','item-actions');actions.append(small('Modifier',()=>openCard(c.id)),small('↑',()=>shift('card',c.id,-1)),small('↓',()=>shift('card',c.id,1)));
    item.append(grab,main,actions);draggable(item,c.id,'card');root.append(item);
  }
}
function openCard(cardId){
  const card=cardById(cardId);if(!card)return;
  selectedCardId=card.id;selectedRowId=null;$('card-editor').hidden=false;$('row-editor').hidden=true;
  $('card-editor-title').textContent=card.title;$('card-title').value=card.title;$('card-icon').value=card.icon;$('card-span').value=String(card.span);
  $('card-description').value=card.description;$('card-url').value=card.url;$('card-enabled').checked=card.enabled;
  renderCards();renderRows();
  const url=new URL(location.href);url.searchParams.set('tab','dashboard');url.searchParams.set('card',card.id);history.replaceState(null,'',url);
  $('card-editor').scrollIntoView({behavior:'smooth',block:'start'});
}
$('new-card').addEventListener('click',async()=>await action(async()=>{
  const r=await api('/api/dashboard/cards','POST',{title:'Nouvelle carte',icon:'◇',description:'MONITORING',enabled:true,span:1,url:''});
  await refreshAll();openCard(r.item.id);
},'Carte ajoutée.'));
$('close-card-editor').addEventListener('click',()=>{selectedCardId=null;selectedRowId=null;$('card-editor').hidden=true;$('row-editor').hidden=true;renderCards();});
$('card-form').addEventListener('submit',async e=>{e.preventDefault();await action(async()=>{
  const r=await api('/api/dashboard/cards','POST',{id:selectedCardId,title:$('card-title').value,icon:$('card-icon').value,description:$('card-description').value,url:$('card-url').value,enabled:$('card-enabled').checked,span:Number($('card-span').value)});
  await refreshAll();openCard(r.item.id);
},'Carte sauvegardée.');});
$('duplicate-card').addEventListener('click',async()=>await action(async()=>{
  const r=await api(`/api/dashboard/cards/${selectedCardId}/duplicate`,'POST');await refreshAll();openCard(r.item.id);
},'Carte dupliquée.'));
$('delete-card').addEventListener('click',async()=>{
  if(!confirm('Supprimer cette carte et toutes ses lignes ?'))return;
  await action(async()=>{await api(`/api/dashboard/cards/${selectedCardId}/delete`,'POST');selectedCardId=null;selectedRowId=null;$('card-editor').hidden=true;$('row-editor').hidden=true;await refreshAll();},'Carte supprimée.');
});
function renderRows(){
  const root=$('row-list');root.replaceChildren();const c=selectedCard();if(!c)return;
  if(!c.rows.length)root.append(node('div','empty-state','Aucune ligne : clique sur « Ajouter une ligne ».'));
  for(const row of c.rows){
    const item=node('div','config-item');
    const grab=node('span','drag-handle','⠿');grab.title='Glisser pour réordonner';
    const main=node('div','item-main');main.append(node('span','item-title',row.label+(row.enabled?'':' · masquée')),node('span','item-meta',summaryRow(row)));
    const actions=node('div','item-actions');actions.append(small('Modifier',()=>openRow(row.id)),small('↑',()=>shift('row',row.id,-1)),small('↓',()=>shift('row',row.id,1)),small('Dupliquer',()=>rowTask('duplicate',row.id)),small('Supprimer',()=>rowTask('delete',row.id),'danger'));
    item.append(grab,main,actions);draggable(item,row.id,'row');root.append(item);
  }
}
async function rowTask(kind,rowId){
  if(kind==='delete'&&!confirm('Supprimer cet indicateur ?'))return;
  await action(async()=>{
    await api(`/api/dashboard/cards/${selectedCardId}/rows/${kind}`,'POST',{id:rowId});
    if(selectedRowId===rowId){selectedRowId=null;$('row-editor').hidden=true;}
    await refreshAll();
  },kind==='delete'?'Ligne supprimée.':'Ligne dupliquée.');
}
function updateSource(){
  const isApi=$('row-source').value==='integration';$('row-integration-fields').hidden=!isApi;$('row-status-fields').hidden=isApi;
  if(!isApi){$('row-transform').value='value';}
}
function renderTemplates(){
  const integration=integrationById($('row-integration').value);
  const applicable=templates.filter(t=>t.type===integration?.type);
  options($('row-template'),applicable,x=>x.id,x=>x.label,'Personnalisé / choisir…');
  if(!applicable.some(t=>t.id===$('row-template').value))$('row-template').value='';
}
function useTemplate(template){
  if(!template)return;
  $('row-label').value=template.label;$('row-endpoint').value=template.endpoint;$('row-field').value=template.field||'';$('row-transform').value=template.transform||'value';
  $('row-preview').hidden=true;$('inspect-result').hidden=true;
}
$('row-template').addEventListener('change',()=>useTemplate(templates.find(x=>x.id===$('row-template').value)));
$('row-integration').addEventListener('change',()=>{renderTemplates();$('row-template').value='';});
$('row-source').addEventListener('change',updateSource);
function openRow(rowId=null,template=null){
  if(!selectedCard())return;
  selectedRowId=rowId;const r=selectedCard().rows.find(x=>x.id===rowId);
  $('row-editor').hidden=false;$('row-editor-title').textContent=r?'Modifier · '+r.label:'Nouvel indicateur';$('row-form').reset();
  $('row-source').value=r?.sourceType||'integration';$('row-label').value=r?.label||'';
  $('row-integration').value=r?.integrationId||integrations[0]?.id||'';
  $('row-path').value=r?.path||'jellyfin.streams';$('row-endpoint').value=r?.endpoint||'';$('row-field').value=r?.field||'';
  $('row-transform').value=r?.transform||'value';$('row-format').value=r?.format||'auto';$('row-suffix').value=r?.suffix||'';$('row-enabled').checked=r?.enabled??true;
  $('row-preview').hidden=true;$('inspect-result').hidden=true;
  if(template){const matching=integrations.find(i=>i.type===template.type);if(matching)$('row-integration').value=matching.id;}
  renderTemplates();if(template){$('row-template').value=template.id;useTemplate(template);}
  updateSource();$('row-editor').scrollIntoView({behavior:'smooth',block:'start'});
}
$('new-row').addEventListener('click',()=>openRow());
$('close-row-editor').addEventListener('click',()=>{$('row-editor').hidden=true;selectedRowId=null;});
$('cancel-row').addEventListener('click',()=>{$('row-editor').hidden=true;selectedRowId=null;});
function rowPayload(){return {id:selectedRowId||undefined,label:$('row-label').value,enabled:$('row-enabled').checked,sourceType:$('row-source').value,path:$('row-path').value,integrationId:$('row-integration').value,endpoint:$('row-endpoint').value,field:$('row-field').value,transform:$('row-transform').value,format:$('row-format').value,suffix:$('row-suffix').value};}
$('row-form').addEventListener('submit',async e=>{e.preventDefault();await action(async()=>{
  await api(`/api/dashboard/cards/${selectedCardId}/rows`,'POST',rowPayload());selectedRowId=null;$('row-editor').hidden=true;await refreshAll();
},'Indicateur sauvegardé.');});
$('preview-metric').addEventListener('click',async()=>{
  const result=$('row-preview');result.hidden=false;result.className='inline-preview';result.textContent='Test de l’API…';
  try{const r=await api('/api/dashboard/preview','POST',rowPayload());result.classList.toggle('bad',!r.ok);result.textContent=r.ok?'✓ Valeur actuelle : '+String(r.value):'✕ '+(r.reason||'Donnée indisponible');}
  catch(e){result.className='inline-preview bad';result.textContent='✕ '+e.message;}
});
$('inspect-endpoint').addEventListener('click',async()=>{
  const result=$('inspect-result');result.hidden=false;result.textContent='Recherche des champs disponibles…';
  try{
    const data=await api('/api/dashboard/inspect','POST',{integrationId:$('row-integration').value,endpoint:$('row-endpoint').value});
    result.replaceChildren();if(!data.paths.length){result.textContent='Aucun champ simple trouvé. Choisis une transformation adaptée.';return;}
    result.append(node('p','hint','Choisis un champ JSON (les valeurs et secrets ne sont pas affichés) :'));
    for(const item of data.paths){result.append(small(item.path+' · '+item.type,()=>{$('row-field').value=item.path;notify('Champ JSON sélectionné : '+item.path);}));}
  }catch(e){result.className='field-browser bad-text';result.textContent=e.message;}
});
// METRICS CATALOG
function renderCatalog(){
  const root=$('metrics-catalog');root.replaceChildren();
  for(const t of templates){
    const source=integrations.filter(i=>i.type===t.type);
    const item=node('div','config-item');const main=node('div','item-main');main.append(node('span','item-title',t.label),node('span','item-meta',`${t.type.toUpperCase()} · ${t.endpoint}${t.field?' → '+t.field:''}`));
    const actions=node('div','item-actions');const button=small(source.length?'Ajouter à une carte':'Connecter '+t.type,()=>{
      if(!source.length){showTab('integrations');$('integration-type').value=t.type;choosePreset();return;}
      showTab('dashboard');const target=cards.find(c=>c.title.toLowerCase().includes(t.type))||cards[0];
      if(target){openCard(target.id);openRow(null,t);}else notify('Crée d’abord une carte dans Dashboard.',true);
    });actions.append(button);item.append(main,actions);root.append(item);
  }
}
// BACKUPS + APP APPEARANCE
$('export-layout').addEventListener('click',async()=>await action(async()=>{
  const data=await api('/api/dashboard/export');const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='PabloHFlix-dashboard-'+new Date().toISOString().slice(0,10)+'.json';document.body.append(a);a.click();a.remove();URL.revokeObjectURL(url);
},'Configuration exportée, sans les secrets API.'));
$('import-layout').addEventListener('click',async()=>{
  const file=$('import-file').files?.[0];if(!file){notify('Sélectionne un fichier JSON.',true);return;}
  if(file.size>490000){notify('Fichier trop volumineux.',true);return;}
  if(!confirm('Remplacer la disposition actuelle par cette sauvegarde ? Les intégrations existantes seront conservées.'))return;
  await action(async()=>{await api('/api/dashboard/import','POST',JSON.parse(await file.text()));selectedCardId=null;$('card-editor').hidden=true;$('row-editor').hidden=true;await refreshAll();},'Disposition restaurée.');
});
$('reset-dashboard').addEventListener('click',async()=>{
  if(!confirm('Remettre les 3 cartes d’origine ? Les cartes personnalisées seront remplacées. Fais d’abord un export.'))return;
  await action(async()=>{await api('/api/dashboard/reset','POST');selectedCardId=null;$('card-editor').hidden=true;$('row-editor').hidden=true;await refreshAll();},'Disposition réinitialisée.');
});
async function renderDiagnostics(){
  const root=$('diagnostic-output');root.replaceChildren(node('p','muted','Vérification des données…'));
  try{
    const status=await api('/api/dashboard/data');
    const rows=(status.cards||[]).flatMap(c=>c.rows);
    root.replaceChildren();
    const summary=node('p','',`${cards.length} cartes · ${integrations.length} intégrations · ${rows.filter(r=>r.ok).length} métriques disponibles / ${rows.length}`);
    root.append(summary);
    for(const c of status.cards){
      const line=node('div','config-item');const good=c.rows.filter(r=>r.ok).length;
      line.append(node('span','item-title',c.title),node('span','item-meta',`${good}/${c.rows.length} indicateurs disponibles`));root.append(line);
    }
  }catch(e){root.replaceChildren(node('p','bad-text',e.message));}
}
$('refresh-diagnostics').addEventListener('click',renderDiagnostics);
// Startup
(async()=>{
  try{
    await refreshAll();resetIntegration();
    const params=new URLSearchParams(location.search);showTab(params.get('tab')||'home',false);
    const card=params.get('card');if(card&&cardById(card)){showTab('dashboard',false);openCard(card);}
  }catch(e){notify('Initialisation impossible : '+e.message,true);}
})();
})();
