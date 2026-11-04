(()=>{'use strict';
const $=id=>document.getElementById(id);
const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=String(text);return el;};
let currentGroup='all',lastStatus=null,latestRss=null;
function displayOverview(data){
  const el=$('top-metrics');if(!el)return;
  const countKnown=[data.vpnMedia,data.vpnRecord].filter(v=>v?.ok).length;
  const activeVpn=[data.vpnMedia,data.vpnRecord].filter(v=>v?.ok&&v.state==='running').length;
  const knownAlerts=data.docker?.ok||countKnown>0;
  const alerts=(data.docker?.unhealthy||0)+([data.vpnMedia,data.vpnRecord].some(v=>v?.ok&&(v.state!=='running'||v.match===false))?1:0);
  const values={
    docker:['DOCKER',data.docker?.ok?`${data.docker.up}/${data.docker.total}`:'—/—'],
    vpn:['VPN',countKnown?`${activeVpn}/${countKnown}`:'—'],
    alerts:['ALERTES',knownAlerts?alerts:'—'],
    storage:['STOCKAGE',Number.isFinite(data.volumes?.volume1?.usedPercent)?`${data.volumes.volume1.usedPercent}%`:'—'],
    sources:['SOURCES',`${data.integrations?.responsive??0}/${data.integrations?.total??7}`],
    rss:['RSS',data.rss?.feeds?.some(f=>f.ok)?data.news.length:'—']
  };
  el.replaceChildren();
  for(const id of (data.experience?.overview||['docker','vpn','alerts'])){
    const [label,value]=values[id]||['MÉTRIQUE','—'];
    const a=node('a','top-metric');a.href='/settings?tab=overview';a.title='Personnaliser les indicateurs de synthèse';
    a.append(node('span','',label),node('b','',String(value)));el.append(a);
  }
}
function displayLinks(config){
  const root=$('shortcut-groups');if(!root)return;root.replaceChildren();
  for(const group of config.quickGroups||[]){
    const links=(config.quickLinks||[]).filter(link=>link.groupId===group.id);
    if(!links.length)continue;
    const section=node('section','shortcut-section');section.append(node('h3','shortcut-label',group.name));
    const grid=node('div','shortcut-grid');
    for(const link of links){const a=node('a','',link.name);a.href=link.url;a.target='_blank';a.rel='noopener noreferrer';grid.append(a);}
    section.append(grid);root.append(section);
  }
  if(!root.children.length)root.append(node('p','muted','Aucun accès rapide. Ajoute tes liens depuis Settings → Accès rapides.'));
}
function displayNews(rss){
  const root=$('news-list'),tabs=$('rss-group-tabs'),hint=$('news-status');if(!root||!tabs)return;
  rss=rss||{groups:[],feeds:[],items:[]};
  if(currentGroup!=='all' && !rss.groups.some(g=>g.id===currentGroup))currentGroup='all';
  tabs.replaceChildren();
  const groups=[{id:'all',name:'Tous'},...(rss.groups||[])];
  for(const g of groups){const button=node('button',currentGroup===g.id?'active':'',g.name);button.type='button';button.setAttribute('aria-pressed',String(currentGroup===g.id));button.addEventListener('click',()=>{currentGroup=g.id;displayNews(latestRss);});tabs.append(button);}
  const items=(rss.items||[]).filter(x=>currentGroup==='all'||x.groupId===currentGroup);
  root.replaceChildren();
  if(!items.length){
    const p=node('p','muted','Aucun article pour cette sélection.');root.append(p);
    if(!rss.feeds?.length)root.append(node('p','muted','Ajoute un flux dans Settings → Flux RSS.'));
  }else for(const item of items.slice(0,9)){
    if(!/^https?:\/\//i.test(item.link))continue;
    const a=node('a','news-item');a.href=item.link;a.target='_blank';a.rel='noopener noreferrer';
    a.append(node('span','pink','■'),node('span','',item.title),node('small','',item.source+(item.stale?' · ancien':'')));
    root.append(a);
  }
  const bad=(rss.feeds||[]).filter(f=>!f.ok);
  hint.textContent=bad.length?`${bad.length} flux indisponible(s) : ${bad.map(f=>f.name+' — '+(f.reason||'Erreur')).join(' · ').slice(0,270)}`:`${(rss.feeds||[]).length} flux surveillé(s)`;
  if(bad.length){hint.className='footnote bad-text';}else hint.className='footnote';
}
async function displaySources(){
  const root=$('source-list');if(!root)return;
  try{
    const res=await fetch('/api/setup/diagnostics',{cache:'no-store'});if(!res.ok)throw Error('Diagnostic HTTP '+res.status);
    const data=await res.json();root.replaceChildren();
    const items=lastStatus?.experience?.resourceSources||['jellyfin','radarr','sonarr','docker','smart','rss'];
    for(const id of items){const item=data.sources?.find(x=>x.id===id);if(!item)continue;
      const row=node('a','source-item');row.href=`/settings?tab=sources#${item.id}`;
      row.append(node('span','',item.label),node('span','source-'+item.kind,item.kind==='ready'?'● OK':item.kind==='partial'?'◐ PARTIEL':item.kind==='missing'?'⚙ À CONFIGURER':item.kind==='stale'?'◷ PÉRIMÉ':'! ERREUR'));
      row.title=item.summary;root.append(row);
    }
  }catch(e){root.replaceChildren(node('p','muted','Diagnostic inaccessible. Ouvre Settings → Sources pour identifier le problème.'));}
}
window.addEventListener('pablo:status',event=>{
  lastStatus=event.detail;
  displayOverview(lastStatus);
  displayLinks(lastStatus.experience||{quickGroups:[],quickLinks:[]});
  // Global status changes must not overwrite the independently loaded RSS articles.
  displaySources();
});
fetch('/api/experience',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(cfg=>{if(cfg)displayLinks(cfg);}).catch(()=>{});
// The RSS feed has its own API. A 500 on /api/status must not blank a working feed.
let rssLoading=false;
async function refreshRss(){
  if(rssLoading)return;
  rssLoading=true;
  try{
    const response=await fetch('/api/rss',{cache:'no-store'});
    if(response.status===401){location.replace('/login');return;}
    if(!response.ok)throw Error(`RSS HTTP ${response.status}`);
    const data=await response.json();
    if(!Array.isArray(data?.items)||!Array.isArray(data?.feeds)||!Array.isArray(data?.groups))throw Error('Réponse RSS invalide');
    latestRss=data;
    displayNews(data);
  }catch(e){
    console.error('[PabloHFlix] Chargement RSS en échec',e);
    if(latestRss){displayNews(latestRss);const hint=$('news-status');if(hint){hint.textContent+=' · Mise à jour impossible';hint.className='footnote bad-text';}}
    else {
      const news=$('news-list');news?.replaceChildren(node('p','bad-text',`Flux RSS indisponibles : ${e.message}. Vérifie Settings → Flux RSS.`));
      const hint=$('news-status');if(hint){hint.textContent='La requête RSS a échoué indépendamment du statut du NAS.';hint.className='footnote bad-text';}
    }
  }finally{rssLoading=false;}
}
refreshRss();setInterval(refreshRss,60000);
window.addEventListener('pablo:status-error',event=>{
  // Only the system status is unavailable. Do not clear RSS content or shortcuts.
  const root=$('source-list');root?.replaceChildren(node('p','bad-text','Statut général indisponible : voir Settings → Sources et les logs du conteneur.'));
  console.error('[PabloHFlix] Statut général indisponible',event.detail);
});
})();
