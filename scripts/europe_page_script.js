<script>
let D = null;
(() => { const n = document.getElementById('tabs'); if(!n) return;
  n.addEventListener('wheel', e => { if(n.scrollWidth > n.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)){ n.scrollLeft += e.deltaY; e.preventDefault(); } }, {passive:false});
})();
const $ = (s, el=document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pct = v => v == null ? '—' : (v*100).toFixed(0) + ' %';
const pcls = v => v >= 0.75 ? 'good' : v >= 0.6 ? 'warn' : '';
const P = v => `<span class="p ${pcls(v)}">${pct(v)}</span>`;
const num = v => { const n = parseFloat(String(v||'').replace(',','.')); return n>1 ? n : null; };
const form = arr => `<span class="form">${(arr||[]).map(r=>`<i class="${r==='V'?'V':r==='P'?'P':'D'}" title="${r==='V'?'Victoire':r==='P'?'Défaite en prolongation':'Défaite'}"></i>`).join('')}</span>`;
const TABS = [['paris','Paris à plus de 50 %'],['public','Les plus joués'],['matchs','Matchs'],['classements','Classements'],['bilan','Bilan'],['methode','Méthode & sources']];
let LG = '';
try{ LG = localStorage.getItem('eu-lg') || ''; }catch(e){}
const inLg = x => !LG || x.lg === LG;

function sortable(table){
  const ths = [...table.querySelectorAll('th')];
  ths.forEach((th,i) => { th.tabIndex = 0; const go = () => { const dir = th.getAttribute('aria-sort') === 'descending' ? 'ascending' : 'descending'; ths.forEach(t => t.removeAttribute('aria-sort')); th.setAttribute('aria-sort', dir);
    const rows = [...table.tBodies[0].rows]; rows.sort((a,b) => { const x = a.cells[i].dataset.v ?? a.cells[i].textContent, y = b.cells[i].dataset.v ?? b.cells[i].textContent; const nx = parseFloat(x), ny = parseFloat(y); const c = (!isNaN(nx) && !isNaN(ny)) ? nx - ny : String(x).localeCompare(String(y), 'fr'); return dir === 'ascending' ? c : -c; }); rows.forEach(r => table.tBodies[0].appendChild(r)); };
    th.addEventListener('click', go); th.addEventListener('keydown', e => { if(e.key==='Enter'||e.key===' '){e.preventDefault();go();} }); });
}
function table(cols, rows){
  return `<div class="tbl"><table><thead><tr>${cols.map(c=>`<th class="${c[2]?'n':''}">${c[0]}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => { const [h,v,cls] = c[1](r); return `<td class="${c[2]?'n':''} ${cls||''}" ${v!=null?`data-v="${esc(v)}"`:''}>${h}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
}
document.addEventListener('input', e => { const t = e.target; if(t.dataset.cp === undefined) return; const out = t.closest('.wmx').querySelector('.res'); const c = num(t.value), p = +t.dataset.cp;
  if(!c){ out.innerHTML=''; return; } const ev = p*c-1; out.innerHTML = ev >= 0.05 ? `<span class="chip good">Valeur : +${(ev*100).toFixed(0)} %</span>` : ev <= -0.05 ? `<span class="chip bad">Cote trop basse (${(ev*100).toFixed(0)} %)</span>` : '<span class="chip">À peu près juste</span>'; });

const bookChip = x => x.cote_book ? (x.valeur >= 0.05 ? `<span class="chip good">Bookmakers ${x.cote_book} · bonne cote (+${Math.round(x.valeur*100)} %)</span>` : x.valeur >= 0 ? `<span class="chip">Bookmakers ${x.cote_book} · cote juste (+${Math.round(x.valeur*100)} %)</span>` : `<span class="chip bad">Bookmakers ${x.cote_book} · trop basse (${Math.round(x.valeur*100)} %)</span>`) : '';
const voteBar = (v, dom, ext) => `<div class="bar"><span class="a" style="width:${v.dom*100}%">${pct(v.dom)}</span><span style="width:${v.nul*100}%;background:var(--line);color:var(--fg)">${v.nul>=0.08?'nul':''}</span><span class="h" style="width:${v.ext*100}%">${pct(v.ext)}</span></div><div class="sub" style="display:flex;justify-content:space-between"><span>${esc(dom)}</span><span>${esc(ext)}</span></div>`;
function publicView(){
  const L = (D.public||[]).filter(inLg), C = (D.contre||[]).filter(inLg), B = D.bilan.public || {};
  const g = b => b ? `${b.gagnes}/${b.n} gagnés, ${b.unites > 0 ? '+' : ''}${b.unites} unités (rendement ${b.rendement > 0 ? '+' : ''}${Math.round(b.rendement*100)} %)` : 'pas encore de pari noté';
  return `<div class="section"><div class="method"><p><b>Ce que jouent les autres parieurs.</b> Pour chaque match KHL, le vote des internautes de sports.ru (« Qui va gagner ? »). Je prends le camp choisi par la majorité (au moins 10 votes) et je garde son pari le plus rentable <b>à plus de 50 % de chances</b> : gagne en 60 min, ou « ou nul ».</p>
    <p><b>La cote.</b> C'est la cote médiane des bookmakers affichés sur la page sports.ru (FONBET, Winline, Betcity…). <b>Bonne cote</b> = elle rapporte au moins 5 % de plus que mes chances ne le demandent. SHL et Liiga : aucun site ne publie de votes ou de pronos en nombre suffisant.</p></div>
    <div class="summary">Suivi des choix du public : ${g(B.tous)}. Seulement ceux à bonne cote : ${g(B.bonne_cote)}. Mes propres paris joués à la cote des bookmakers : ${g(B.mes_paris_a_la_cote)}.</div>
    <h2>Les plus joués, du meilleur rapport au moins bon</h2>
    ${L.length?`<div class="picks">${L.map((x,i)=>`<article class="pick"><div class="top"><span class="rank">${i+1}</span><div class="who"><b>${esc(x.label)}</b> <span class="sub">${esc(x.lg)} · ${esc(x.match)} · ${esc(x.heure)}</span></div><span class="big">${pct(x.prob)}</span></div>
      <div class="sub" style="margin:6px 0 2px">${Math.round(x.part*100)} % des ${x.votes} votants choisissent ${esc(x.equipe)}</div>${voteBar(x.vote, x.match.split(' – ')[0], x.match.split(' – ')[1])}
      <div class="chips">${bookChip(x)}<span class="chip">Cote juste ${x.cote_juste}</span><span class="chip good">Jouable dès ${x.cote_min}</span></div>
      <div class="wmx"><label>Cote Winamax<input inputmode="decimal" data-cp="${x.prob}" placeholder="ex. ${x.cote_min}"></label><div class="res sub"></div></div></article>`).join('')}</div>`:'<div class="empty">Pas de vote du public disponible pour les matchs d’aujourd’hui et de demain.</div>'}
    ${C.length?`<h2>Le public contre les chiffres (à éviter)</h2><p class="lead">Le public choisit ce camp, mais aucun de ses paris ne dépasse 50 % de chances selon mes calculs.</p>${table([['Match',x=>[`${esc(x.match)}<br><span class="sub">${esc(x.lg)} · ${esc(x.heure)}</span>`,x.utc]],['Choix du public',x=>[`${esc(x.equipe)} (${Math.round(x.part*100)} % de ${x.votes} votes)`,x.part],1],['Mes chances de victoire en 60 min',x=>[P(x.prob_victoire),x.prob_victoire],1],['Cote bookmakers',x=>[x.cote??'—',x.cote],1]], C)}`:''}
    ${(D.historique_public||[]).length?`<h2>Choix du public déjà notés</h2>${table([['Date',p=>[esc(p.date),p.date]],['Match',p=>[esc(p.match),p.match]],['Pari',p=>[esc(p.label),p.label]],['Chances',p=>[pct(p.prob),p.prob],1],['Cote',p=>[p.cote??'—',p.cote],1],['Score',p=>[esc(p.score||''),0]],['Résultat',p=>[p.resultat===1?'<span class="chip good">Gagné</span>':p.resultat===0?'<span class="chip bad">Perdu</span>':'<span class="chip">Annulé</span>',p.resultat]]], D.historique_public.filter(inLg))}`:''}</div>`;
}
function paris(){
  const L = D.picks.filter(inLg);
  const top = L.slice(0, 10);
  return `<div class="section"><div class="method"><p><b>Seulement les paris à plus de 50 % de chances</b>, pour les matchs d'aujourd'hui et de demain (heure de Paris). Pour chaque pari : mes chances, la cote juste (1 ÷ chances) et la cote à partir de laquelle il vaut le coup (5 % de marge). Joue seulement si Winamax paie au moins cette cote : un pari à 80 % payé 1,15 perd de l'argent à long terme.</p>
    <p>« 60 min » = temps réglementaire, prolongation non comptée. « Prolongation incluse » = vainqueur final. Les totaux comptent la prolongation et les tirs au but (1 but de plus).</p></div>
    <h2>Les 10 paris les plus probables</h2>
    ${top.length?`<div class="picks">${top.map((x,i)=>`<article class="pick"><div class="top"><span class="rank">${i+1}</span><div class="who"><b>${esc(x.label)}</b> <span class="sub">${esc(x.lg)} · ${esc(x.match)} · ${esc(x.heure)}</span></div><span class="big">${pct(x.prob)}</span></div>
      <div class="chips">${bookChip(x)}<span class="chip">Cote juste ${x.cote_juste}</span><span class="chip good">Jouable dès ${x.cote_min}</span></div>
      <div class="wmx"><label>Cote Winamax<input inputmode="decimal" data-cp="${x.prob}" placeholder="ex. ${x.cote_min}"></label><div class="res sub"></div></div></article>`).join('')}</div>`:'<div class="empty">Aucun match prévu aujourd’hui ni demain dans ces championnats.</div>'}
    <h2>Tous les paris à plus de 50 %</h2>
    ${L.length?table([['Pari',x=>[`<b>${esc(x.label)}</b>`,x.label]],['Match',x=>[`${esc(x.match)}<br><span class="sub">${esc(x.lg)} · ${esc(x.heure)}</span>`,x.utc]],['Mes chances',x=>[P(x.prob),x.prob],1],['Cote juste',x=>[x.cote_juste,x.cote_juste],1],['Jouable dès',x=>[`<b>${x.cote_min}</b>`,x.cote_min],1],['Cote bookmakers',x=>[x.cote_book?`${x.cote_book} <span class="chip ${x.valeur>=0.05?'good':x.valeur<0?'bad':''}">${x.valeur>0?'+':''}${Math.round(x.valeur*100)} %</span>`:'—',x.valeur??-9],1]], L):''}</div>`;
}
function matchs(){
  const M = D.matchs.filter(inLg);
  return M.length ? `<div class="grid-games">${M.map(m=>`<article class="game"><div class="hd"><span>${esc(m.lg)} · ${esc(m.heure)} (Paris)</span></div>
    <div class="matchup"><div class="team"><span class="abbr" style="font-size:1.3rem">${esc(m.dom)}</span><span class="sub">domicile · ${m.buts.dom} buts attendus</span></div><span class="at">–</span><div class="team r"><span class="abbr" style="font-size:1.3rem">${esc(m.ext)}</span><span class="sub">${m.buts.ext} buts attendus</span></div></div>
    <div class="bar"><span class="a" style="width:${m.p60.dom*100}%">${pct(m.p60.dom)}</span><span style="width:${m.p60.nul*100}%;background:var(--line);color:var(--fg)">nul</span><span class="h" style="width:${m.p60.ext*100}%">${pct(m.p60.ext)}</span></div>
    ${m.public?`<div class="sub" style="margin-top:8px">Vote du public (${m.public.votes} votes)</div>${voteBar(m.public.vote, m.dom, m.ext)}`:''}
    <ul class="logic">${m.why.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>
    ${m.paris.length?table([['Pari (plus de 50 %)',x=>[esc(x.label),x.label]],['Chances',x=>[P(x.prob),x.prob],1],['Cote juste',x=>[x.cote_juste,x.cote_juste],1],['Jouable dès',x=>[x.cote_min,x.cote_min],1],['Bookmakers',x=>[x.cote_book??'—',x.cote_book],1]], m.paris):'<div class="sub">Aucun pari au-dessus de 50 %.</div>'}</article>`).join('')}</div>` : '<div class="empty">Aucun match prévu aujourd’hui ni demain.</div>';
}
function classements(){
  return Object.entries(D.leagues).filter(([k])=>!LG||k===LG).map(([k,v])=>`<h2>${esc(k)}</h2><p class="lead">Source : ${esc(v.source)} · ${v.moyenne} buts par match en moyenne (60 min). Attaque et défense : buts marqués et encaissés par match, ramenés vers la moyenne en début de saison.</p>
    ${table([['Équipe',r=>[`<b>${esc(r.team)}</b>`,r.team]],['MJ',r=>[r.mj,r.mj],1],['V',r=>[r.v,r.v],1],['dont prol.',r=>[r.vo,r.vo],1],['D',r=>[r.d,r.d],1],['dont prol.',r=>[r.dp,r.dp],1],['Buts',r=>[`${r.bp}-${r.bc}`,r.bp-r.bc],1],['Pts',r=>[r.pts,r.pts],1],['Attaque',r=>[r.att??'—',r.att],1],['Défense',r=>[r.def??'—',-(r.def||0)],1],['Forme',r=>[r.forme.length?form(r.forme):'<span class="sub">n.d.</span>',r.forme.filter(x=>x==='V').length]]], v.classement)}`).join('');
}
function bilan(){
  const B = D.bilan, H = D.historique.filter(inLg);
  const row = cols => table([['',b=>[esc(b.cle),b.cle]],['Paris',b=>[b.n,b.n],1],['Gagnés',b=>[`${b.gagnes} (${pct(b.reel)})`,b.reel],1],['Annoncé',b=>[pct(b.prevu),b.prevu],1],['Écart',b=>{const e=b.reel-b.prevu;return [`<span class="chip ${Math.abs(e)<0.05?'':e>0?'good':'bad'}">${e>0?'+':''}${Math.round(e*100)} pts</span>`,e]},1]], cols);
  return `<div class="section"><div class="summary">${B.total.n?`Depuis le lancement : <b>${B.total.gagnes}/${B.total.n} paris gagnés (${pct(B.total.gagnes/B.total.n)})</b> pour ${pct(B.total.prevu)} annoncés en moyenne. Je suis les 3 paris les plus probables de chaque match.`:'Le bilan démarre avec les premiers matchs notés.'} Sur la saison passée rejouée (${D.backtest.KHL + D.backtest.SHL + D.backtest.Liiga} matchs), les paris annoncés à 55, 65, 74 et 85 % ont gagné environ 56, 65, 74 et 84 % du temps.</div>
    ${B.par_ligue.length?`<h2>Par championnat</h2>${row(B.par_ligue)}<h2>Par niveau de confiance</h2>${row(B.par_niveau)}<h2>Par type de pari</h2>${row(B.par_marche)}`:''}
    <h2>Derniers paris notés</h2>${H.length?table([['Date',p=>[esc(p.date),p.date]],['Ligue',p=>[esc(p.lg),p.lg]],['Match',p=>[esc(p.match),p.match]],['Pari',p=>[esc(p.label),p.label]],['Chances',p=>[pct(p.prob),p.prob],1],['Score',p=>[esc(p.score||''),0]],['Résultat',p=>[p.resultat===1?'<span class="chip good">Gagné</span>':p.resultat===0?'<span class="chip bad">Perdu</span>':'<span class="chip">Annulé</span>',p.resultat]]], H):'<div class="empty">Pas encore de pari noté.</div>'}</div>`;
}
function methode(){
  return `<div class="section"><div class="method"><p><b>Le calcul.</b> Pour chaque équipe, je calcule ses buts marqués et encaissés par match en temps réglementaire. En début de saison, je les ramène vers la moyenne et vers son niveau de la saison passée. J'en déduis les buts attendus de chaque équipe dans le match (attaque × défense adverse × avantage du domicile mesuré dans la ligue), puis toutes les probabilités avec une loi de Poisson.</p>
    <p>J'ajoute un léger surplus de matchs nuls en 60 minutes, mesuré sur la saison passée. Enfin, je recale chaque type de pari sur ce qui s'est vraiment passé à ce niveau de confiance, avec les résultats de la saison passée puis ceux notés chaque jour.</p>
    <p><b>Vérification.</b> J'ai rejoué toute la saison 2025-26 jour par jour, sans connaître les résultats à l'avance : ${D.backtest.KHL} matchs KHL, ${D.backtest.SHL} SHL et ${D.backtest.Liiga} Liiga. Les probabilités annoncées correspondent aux résultats réels, à 1 à 3 points près.</p>
    <p><b>Sources.</b> SHL et Liiga : sites officiels des ligues (calendrier et résultats match par match). KHL : sports.ru, grand média sportif russe, parce que le site officiel khl.ru refuse les programmes automatiques. Pour la KHL de cette saison, je n'ai que le classement (buts marqués et encaissés), pas le détail match par match. Les résultats sont notés en comparant le classement avant et après le match.</p>
    <p><b>Les plus joués.</b> Vote « Qui va gagner ? » des internautes de sports.ru et cotes des bookmakers affichées sur la page de chaque match KHL (cote médiane quand plusieurs bookmakers sont affichés, car l'un d'eux affiche parfois une cote périmée). Je suis ces choix à part, à la cote du bookmaker, pour mesurer s'ils rapportent vraiment.</p>
    <p><b>Pas encore couverts.</b> DEL (Allemagne), National League (Suisse), Extraliga (Tchéquie) : pas de source fiable et accessible trouvée pour l'instant.</p>
    <p>${esc(D.meta.note)}</p></div></div>`;
}
function init(){
  const m = D.meta;
  $('#h-title').textContent = `Hockey européen · ${m.soiree.split('-').reverse().join('/')}`;
  $('#h-mode').textContent = `ANALYSE · ${String(m.genere).replace(/^(\d\d\/\d\d)\/\d{4} (\d\d:\d\d).*/, '$1 à $2')}`;
  $('#h-meta').innerHTML = Object.entries(m.sources).map(([k,v])=>`<span>${esc(k)} : ${esc(v)}</span>`).join('');
  const views = {paris, public: publicView, matchs, classements, bilan, methode};
  $('#tabs').innerHTML = `<label class="sub" style="align-self:center;margin-right:8px">Championnat <select id="f-lg"><option value="">Tous</option><option ${LG==='KHL'?'selected':''}>KHL</option><option ${LG==='SHL'?'selected':''}>SHL</option><option ${LG==='Liiga'?'selected':''}>Liiga</option></select></label>` + TABS.map(([id,l])=>`<button role="tab" id="t-${id}" aria-controls="p-${id}" aria-selected="false">${l}</button>`).join('');
  $('#panels').innerHTML = TABS.map(([id])=>`<section role="tabpanel" id="p-${id}" aria-labelledby="t-${id}" hidden>${views[id]()}</section>`).join('');
  document.querySelectorAll('#panels .tbl table').forEach(sortable);
  const show = id => { TABS.forEach(([t])=>{ $('#t-'+t).setAttribute('aria-selected', t===id); $('#p-'+t).hidden = t!==id; }); try{ localStorage.setItem('eu-tab', id); }catch(e){} };
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if(b) show(b.id.slice(2)); });
  $('#f-lg').addEventListener('change', e => { LG = e.target.value; try{ localStorage.setItem('eu-lg', LG); }catch(err){} const cur = document.querySelector('#tabs [aria-selected="true"]')?.id?.slice(2); init(); if(cur) show(cur); });
  let start = 'paris'; try{ start = localStorage.getItem('eu-tab') || 'paris'; }catch(e){}
  show(TABS.some(t=>t[0]===start) ? start : 'paris');
  $('#foot').innerHTML = 'Estimations statistiques, pas des certitudes. Comparez toujours avec les cotes de votre opérateur. Les paris comportent un risque de perte : misez de façon responsable, uniquement ce que vous pouvez vous permettre de perdre. Sources : sports.ru (KHL, votes et cotes), shl.se (SHL), liiga.fi (Liiga).';
}
async function launch(){
  const b = $('.runbar button.run'), msg = $('#run-msg'); b.disabled = true; msg.textContent = 'Analyse en cours… (environ 15 secondes)';
  try{ const r = await fetch('/api/europe/run', {method:'POST'}); const j = await r.json().catch(()=>({})); if(!j.ok){ msg.textContent = j.message || 'L’analyse a échoué.'; return; } msg.textContent = `Terminé en ${j.duree_s} s. ${(j.log||[]).join(' · ')}`; await load(); }
  catch(e){ msg.textContent = 'Connexion impossible. Réessaie.'; } finally { b.disabled = false; }
}
function exportXlsx(){
  const wb = XLSX.utils.book_new();
  const add = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  add('Paris du jour', D.picks.map(x=>({ligue:x.lg, match:x.match, heure:x.heure, pari:x.label, chances:x.prob, cote_juste:x.cote_juste, jouable_des:x.cote_min, cote_bookmakers:x.cote_book, valeur:x.valeur})));
  add('Plus joués', (D.public||[]).map(x=>({ligue:x.lg, match:x.match, heure:x.heure, choix_public:x.equipe, part_votes:x.part, votes:x.votes, pari:x.label, chances:x.prob, cote_bookmakers:x.cote_book, valeur:x.valeur, jouable_des:x.cote_min})));
  add('Historique', D.historique.map(p=>({date:p.date, ligue:p.lg, match:p.match, pari:p.label, chances:p.prob, score:p.score||'', resultat:p.resultat})));
  for (const [k,v] of Object.entries(D.leagues)) add('Classement '+k, v.classement.map(r=>({equipe:r.team, mj:r.mj, v:r.v, vo:r.vo, d:r.d, dp:r.dp, bp:r.bp, bc:r.bc, pts:r.pts})));
  XLSX.writeFile(wb, `Hockey_Europe_${D.meta.soiree}.xlsx`);
}
async function load(){
  try{ D = await (await fetch('/api/europe/data',{cache:'no-store'})).json(); }catch(e){ D = null; }
  if(!D){ $('#panels').innerHTML = '<div class="empty">Aucune analyse enregistrée. Appuie sur « Lancer l’analyse ».</div>'; return; }
  init();
}
$('.runbar button.run').addEventListener('click', launch);
$('#xls').addEventListener('click', exportXlsx);
load();
</script>
