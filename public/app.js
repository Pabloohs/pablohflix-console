(()=>{'use strict';
  const themes=['terminal','matrix','midnight','minimal'];
  const preference=localStorage.getItem('pablo-theme');
  const theme=themes.includes(preference)?preference:'terminal';
  document.body.dataset.theme=theme;
  const chooser=document.getElementById('theme');if(chooser){chooser.value=theme;chooser.addEventListener('change',e=>{if(!themes.includes(e.target.value))return;document.body.dataset.theme=e.target.value;localStorage.setItem('pablo-theme',e.target.value);});}
  const $=id=>document.getElementById(id);
  const txt=(id,val)=>{const el=$(id);if(el)el.textContent=val==null?'—':String(val);};
  const pct=(id,v)=>{const el=$(id);if(el)el.style.width=(typeof v==='number'?Math.max(0,Math.min(100,v)):0)+'%';};
  const val=(v, suffix='')=>typeof v==='number'?`${v}${suffix}`:'—';
  const bytes=b=>typeof b==='number'?(b/(1024**4)).toLocaleString('fr-FR',{maximumFractionDigits:2})+' Tio':'—';
  const state=(id,ok)=>{const el=$(id);if(!el)return;el.textContent=ok===true?'● CONNECTÉ':ok===false?'— NON CONNECTÉ':'—';el.className='mini-state '+(ok===true?'good':'neutral');};
  const dot=(id,value)=>{const el=$(id);if(el)el.className='status-dot '+(value===true?'good':value===false?'bad':'neutral');};
  function clock(){const n=new Date();txt('day',new Intl.DateTimeFormat('fr-FR',{weekday:'short',day:'2-digit',month:'short',year:'numeric'}).format(n));txt('clock',new Intl.DateTimeFormat('fr-FR',{hour:'2-digit',minute:'2-digit',hour12:false}).format(n));}
  clock();setInterval(clock,30000);
  const login=$('login-form');
  if(login){login.addEventListener('submit',async e=>{e.preventDefault();txt('login-error','');const form=new FormData(login);try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:form.get('username'),password:form.get('password')})});const data=await r.json();if(!r.ok)throw Error(data.error||'Connexion impossible');location.replace('/');}catch(err){txt('login-error',err.message);}});return;}
  const logout=$('logout');logout?.addEventListener('click',async()=>{await fetch('/api/logout',{method:'POST'});location.assign('/login');});
  function render(data){
    const sys=data.system||{},docker=data.docker||{},vol=data.volumes||{},disks=data.disks||[];
    txt('cpu',val(sys.cpu,' %'));txt('ram',val(sys.ram,' %'));txt('uptime',typeof sys.uptimeSeconds==='number'?`${Math.floor(sys.uptimeSeconds/86400)} j ${Math.floor(sys.uptimeSeconds%86400/3600)} h`:'—');pct('cpu-bar',sys.cpu);pct('ram-bar',sys.ram);
    for(const [key,prefix] of [['volume1','v1'],['volume2','v2']]){const v=vol[key]||{};txt(prefix+'-percent',val(v.usedPercent,' %'));txt(prefix+'-size',v.totalBytes!=null?`${bytes(v.totalBytes-v.freeBytes)} / ${bytes(v.totalBytes)}`:'Mesure en attente');pct(prefix+'-bar',v.usedPercent);}
    txt('record-free',val(vol.volume2?.freePercent,' %'));pct('record-free-bar',vol.volume2?.freePercent);

    const disksList=$('disks-list');disksList.replaceChildren();
    if(disks.length===0){const p=document.createElement('p');p.className='muted';p.textContent='En attente de l’inventaire SMART';disksList.append(p);}
    else disks.forEach(d=>{const row=document.createElement('div');row.className='diskrow';const span=document.createElement('span');span.textContent=`${d.device} · ${d.model||d.size}`;span.title=d.model;const temp=document.createElement('b');temp.textContent=d.tempC==null?'—':`${d.tempC} °C`;const health=document.createElement('strong');health.textContent=d.health==='PASSED'?'OK':d.health==='FAILED'?'ALERTE':'?';health.className=d.health==='PASSED'?'good-text':d.health==='FAILED'?'bad-text':'subdued';row.append(span,temp,health);disksList.append(row);});
    const j=data.jellyfin||{};txt('jelly-streams',val(j.streams));txt('jelly-transcodes',val(j.transcodes));txt('jelly-users',val(j.users));state('jellyfin-badge',j.ok||false);
    const r=data.radarr||{},s=data.sonarr||{},q=data.seerr||{};
    txt('radarr-missing',val(r.missing));txt('sonarr-missing',val(s.missing));txt('arr-queue',r.queue!=null&&s.queue!=null?String(r.queue+s.queue):'—');txt('seerr-pending',val(q.pending));state('arr-badge',r.ok&&s.ok);
    for(const [key,prefix] of [['vpnMedia','vpn-media'],['vpnRecord','vpn-record']]){const v=data[key]||{};const running=v.ok&&v.state==='running';const match=v.match===false?false:null;dot(prefix+'-dot',v.ok?Boolean(running)&&match!==false:v.configured?false:null);txt(prefix+'-state',v.ok?(running?'RUNNING':v.state==='unknown'?'INCONNU':'ARRÊTÉ'):v.configured?'ERREUR':'—');const details=v.ok?`${v.country||(v.expected?'Pays non vérifié':'Pays non mesuré')} · ${v.ip||'IP non mesurée'}${v.match===false?' · PAYS INCORRECT':''}${v.partial&&v.reason?' · '+v.reason:''}`:v.configured?(v.reason||'Statut VPN inaccessible'):'Intégration à associer dans Settings → Sources';txt(prefix+'-detail',details);}
    const vm=data.vpnMedia,vr=data.vpnRecord;
    const vpnOn=[vm,vr].filter(x=>x?.ok&&x.state==='running').length;const vpnCount=[vm,vr].filter(x=>x?.ok).length;
txt('record-country',vr?.ok?vr.country||'Inconnu':'—');
    txt('updated',new Date(data.timestamp).toLocaleTimeString('fr-FR'));
    // Only proven failures are alerts. Unknown/absent connectors are not treated as healthy.
    const down=docker.ok?docker.unhealthy:0;
    const badVpn=[vm,vr].some(v=>v?.ok&&(v.state!=='running'||v.match===false));
    const warnings=(down||0)+(badVpn?1:0);
    window.dispatchEvent(new CustomEvent('pablo:status',{detail:data}));
    const globalState=$('global-state');
    if(warnings>0){globalState.textContent='● ATTENTION';globalState.className='pill warn';}
    else if(j.ok&&r.ok&&s.ok&&docker.ok&&vpnCount===2){globalState.textContent='● SUPERVISION ACTIVE';globalState.className='pill good';}
    else {globalState.textContent='● SUPERVISION PARTIELLE';globalState.className='pill neutral';}
  }
  let busy=false;
  async function refresh(){if(busy)return;busy=true;try{const res=await fetch('/api/status',{cache:'no-store'});if(res.status===401){location.replace('/login');return;}if(!res.ok)throw Error('réponse '+res.status);render(await res.json());}catch(e){console.error('[PabloHFlix] Statut NAS indisponible',e);txt('updated','Statut NAS indisponible');const state=$('global-state');state.textContent='● STATUT NAS INDISPONIBLE';state.title='Le statut général /api/status a échoué : '+String(e?.message||'Erreur inconnue')+' · Les flux RSS sont chargés séparément.';state.className='pill warn';window.dispatchEvent(new CustomEvent('pablo:status-error',{detail:String(e?.message||e)}));}finally{busy=false;}}
  $('refresh')?.addEventListener('click',refresh);refresh();setInterval(refresh,30000);
})();
