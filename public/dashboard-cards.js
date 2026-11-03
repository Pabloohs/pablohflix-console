(()=>{'use strict';
const grid=document.getElementById('dashboard-cards');
if(!grid)return;
const editButton=document.getElementById('toggle-dashboard-edit');
let editMode=false,dragging=null, cards=[];
const node=(tag,className,value)=>{const el=document.createElement(tag);if(className)el.className=className;if(value!==undefined)el.textContent=String(value);return el;};
const formatter=(row)=>{
  if(!row.ok||row.value===null||row.value===undefined)return '—';
  const v=row.value;
  let result;
  if(typeof v==='number'){
    if(row.format==='bytes')result=new Intl.NumberFormat('fr-FR',{maximumFractionDigits:1}).format(v/1073741824)+' Gio';
    else if(row.format==='duration')result=Math.floor(v/3600)+'h '+Math.floor(v%3600/60)+'m';
    else result=new Intl.NumberFormat('fr-FR',{maximumFractionDigits:row.format==='percent'?1:2}).format(v);
  }else result=String(v);
  return result+(row.suffix||'');
};
async function reorderCards(from,to){
  const ids=cards.map(c=>c.id);const a=ids.indexOf(from),b=ids.indexOf(to);
  if(a<0||b<0||a===b)return;
  const moved=ids.splice(a,1)[0];ids.splice(b,0,moved);
  const resp=await fetch('/api/dashboard/cards/reorder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});
  if(!resp.ok)throw Error('Ordre non enregistré');
  await refresh();
}
function render(data){
  cards=data.cards||[];
  grid.replaceChildren();
  if(!cards.length){const hint=node('p','muted','Aucune carte visible. Ajoute une carte dans Settings → Dashboard.');grid.append(hint);return;}
  for(const c of cards){
    const article=node('article','panel configurable-card');article.dataset.cardId=c.id;
    if(c.span>1)article.dataset.span=c.span;
    article.draggable=editMode;
    const heading=node('h2');const icon=node('i','',c.icon||'◇');const title=node('span','',c.title);heading.append(icon,title);
    const state=node('span','mini-state '+(c.rows.some(r=>r.ok)?'good':'neutral'),c.rows.some(r=>r.ok)?'● ACTIF':'—');
    heading.append(state);article.append(heading);
    for(const r of c.rows){
      const line=node('div','count-row configurable-row');
      const label=node('span','',r.label);const val=node('b',r.ok?'':'subdued',formatter(r));
      if(!r.ok)val.title=r.reason||'Donnée indisponible';
      line.append(label,val);article.append(line);
    }
    if(c.rows.length===0)article.append(node('p','muted','Aucune ligne configurée.'));
    const footer=node('div','card-bottom');footer.append(node('span','',c.description||'PABLOHFLIX'));
    const links=node('span','card-links');
    if(c.url){const link=node('a','','OUVRIR ↗');link.href=c.url;link.target='_blank';link.rel='noopener noreferrer';links.append(link);}
    const edit=node('a','card-edit-link',editMode?'DÉPLACER ↕':'ÉDITER ⚙');edit.href='/settings?tab=dashboard&card='+encodeURIComponent(c.id);links.append(edit);footer.append(links);article.append(footer);
    article.addEventListener('dragstart',e=>{if(!editMode){e.preventDefault();return;}dragging=c.id;article.classList.add('is-dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',c.id);});
    article.addEventListener('dragend',()=>{dragging=null;article.classList.remove('is-dragging');});
    article.addEventListener('dragover',e=>{if(editMode&&dragging&&dragging!==c.id){e.preventDefault();e.dataTransfer.dropEffect='move';}});
    article.addEventListener('drop',async e=>{if(!editMode||!dragging)return;e.preventDefault();try{await reorderCards(dragging,c.id);}catch{alert('Impossible de sauvegarder l’ordre des cartes.');}});
    grid.append(article);
  }
}
async function refresh(){
  try{
    const r=await fetch('/api/dashboard/data',{cache:'no-store'});
    if(r.status===401){location.replace('/login');return;}
    if(!r.ok)throw Error('API '+r.status);
    render(await r.json());
  }catch(e){if(!grid.childElementCount)grid.append(node('p','bad-text','Cartes indisponibles : '+e.message));}
}
editButton?.addEventListener('click',()=>{editMode=!editMode;editButton.setAttribute('aria-pressed',String(editMode));editButton.textContent=editMode?'✓ Terminer':'↕ Organiser';if(cards.length)render({cards});});
refresh();setInterval(refresh,30000);
})();
