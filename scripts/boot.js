// ---- Apprentissage : journal critique quotidien
function appr(){
  const L = D.learning || {}; const P = L.params || {}; const PR = L.priors || {};
  const fmtP = (k,v) => ['home','b2b','inj','h2h','form','vthr'].includes(k) ? (v*100).toFixed(1)+' %' : k==='wm' ? Math.round(v*100)+' %' : Number(v).toFixed(2);
  const rows = Object.keys(PR).map(k => ({k, label: PR[k].label, v: P[k], d: PR[k].v}));
  const J = L.journal || [];
  const m = (J[0] || {}).metrics || {};
  const metric = (lab, v, hint) => `<div><span>${lab}</span><b>${v==null?'—':v}${hint?` <span class="sub">${hint}</span>`:''}</b></div>`;
  return `<div class="section"><p class="lead">Chaque matin, je compare mes prédictions aux résultats. Je ne réajuste mes réglages que lorsque l'écart est statistiquement solide (sinon c'est du hasard), et je note ici ce que j'en retiens. Log-loss : plus bas = mieux ; 0,693 = pile ou face.</p>
   <article class="game"><div class="kv">
     ${metric('Matchs évalués (modèle complet)', m.n_matchs)}${metric('Log-loss du modèle', m.logloss_modele)}
     ${metric('Log-loss marché (cotes nhl.com)', m.logloss_marche)}${metric('Log-loss modèle seul', m.logloss_modele_seul)}
     ${metric('Gardiens projetés corrects', m.gardiens_prevus_corrects==null?null:Math.round(m.gardiens_prevus_corrects*100)+' %', m.n_gardiens?`(${m.n_gardiens} cas)`:'')}
   </div></article>
   <h2>Réglages actuels</h2>${table([['Réglage',r=>[esc(r.label),r.label]],['Valeur apprise',r=>[fmtP(r.k,r.v),r.v],1],['Départ',r=>[fmtP(r.k,r.d),r.d],1],['Écart',r=>[r.v===r.d?'<span class="sub">inchangé</span>':`<span class="chip warn">${r.v>r.d?'+':''}${fmtP(r.k,r.v-r.d)}</span>`,r.v-r.d]]], rows)}
   <h2>Journal critique</h2>
   <div class="journal">${J.map(j=>`<article><h3>${frDate(j.date)}</h3>
     ${(j.misses||[]).length?`<div><b>Erreurs marquantes de la veille</b><ul>${j.misses.map(x=>`<li>${esc(x.match)} : favori ${esc(x.favori)} à ${pct(x.prob)} a perdu. Pistes : ${esc(x.causes.join(' ; '))}.</li>`).join('')}</ul></div>`:''}
     ${(j.changes||[]).length?`<div><b>Ajustements</b><ul>${j.changes.map(c=>`<li>${esc(c.explication||c.label)}</li>`).join('')}</ul></div>`:''}
     ${(j.lessons||[]).length?`<div><b>Leçons</b><ul>${j.lessons.map(l=>`<li>${esc(l)}</li>`).join('')}</ul></div>`:'<span class="sub">Aucune leçon statistiquement solide pour l’instant.</span>'}
   </article>`).join('') || '<div class="empty">Le journal démarre après la première soirée évaluée.</div>'}</div></div>`;
}

// ---- Lancer une analyse depuis n'importe quel appareil
async function launch(mode){
  const btns = document.querySelectorAll('.runbar button.run'); const msg = $('#run-msg');
  btns.forEach(b=>b.disabled=true); msg.textContent = `${mode==='prematch'?'PRÉ-MATCH':'MISE À JOUR'} en cours… (environ 20 secondes)`;
  try{
    const r = await fetch('/api/run?mode='+mode, {method:'POST'}); const j = await r.json().catch(()=>({}));
    if(!j.ok){ msg.textContent = j.message || 'L’analyse a échoué. Réessaie dans une minute.'; return; }
    msg.textContent = `Terminé en ${j.duree_s} s. ${(j.log||[]).join(' · ')}`;
    await load();
  }catch(e){ msg.textContent = 'Connexion impossible. Vérifie ton réseau puis réessaie.'; }
  finally{ btns.forEach(b=>b.disabled=false); }
}

// ---- Export Excel (toutes les feuilles, historique complet)
async function exportXlsx(){
  const msg = $('#run-msg'); msg.textContent = 'Préparation du fichier Excel…';
  try{
    const db = await (await fetch('/api/data?what=history',{cache:'no-store'})).json();
    const wb = XLSX.utils.book_new();
    const sheet = (name, rows, cols) => { const data = (rows||[]).map(r=>Object.fromEntries(cols.map(c=>[c, Array.isArray(r[c]) ? r[c].join('; ') : r[c]]))); const ws = XLSX.utils.json_to_sheet(data, {header: cols}); ws['!cols'] = cols.map(c=>({wch: Math.max(10, c.length+2)})); XLSX.utils.book_append_sheet(wb, ws, name); };
    sheet('Résultats', db.results, ['date','exterieur','score_ext','score_dom','domicile','mode','tirs_ext','tirs_dom','gardiens','lieu','vainqueur','faits','source','consulte']);
    sheet('Équipes', db.teams, ['date','equipe','nom','mj','v','d','dp','pts','pct_pts','rang_div','rang_conf','bp_match','bc_match','tirs_match','tirs_contre_match','pct_an','pct_dn','pct_arrets','pdo','chance_bm','corsi','corsi_serre','xgf','xga','bilan10','serie','dom','ext','source','consulte']);
    sheet('Joueurs', db.players, ['date','match','equipe','nom','pos','statut','ligne','mj','buts','passes','points','tirs','pct_tirs','buts_match','pts_match','l10_buts_match','l10_pts_match','toi','toi_an','sequence','vs_adv','p_but','p_passe','p_point','source','consulte']);
    sheet('Blessures', db.injuries, ['date','team','player','status','detail','updated','source','consulte']);
    sheet('Prédictions', db.predictions, ['date','etape','match','type','selection','prob','cote','prob_implicite','valeur','confiance','resultat','consulte']);
    sheet('Cotes', db.odds, ['date','match','marche','selection','cote','prob_implicite','source','heure']);
    sheet('Apprentissage', (db.journal||[]).map(j=>({date:j.date, ajustements:(j.changes||[]).map(c=>c.explication||c.label), lecons:j.lessons||[], erreurs:(j.misses||[]).map(x=>`${x.match} (${Math.round(x.prob*100)} %) : ${x.causes.join(', ')}`)})), ['date','ajustements','lecons','erreurs']);
    XLSX.writeFile(wb, `NHL_suivi_${D?.meta?.soiree || 'export'}.xlsx`);
    msg.textContent = 'Fichier Excel téléchargé.';
  }catch(e){ msg.textContent = 'Export impossible pour le moment.'; }
}

let wmxReady = false;
async function load(){
  try{ D = await (await fetch('/api/data',{cache:'no-store'})).json(); }catch(e){ D = null; }
  if(!D){ $('#panels').innerHTML = '<div class="empty">Aucune analyse enregistrée pour l’instant. Appuie sur « Lancer MISE À JOUR » pour démarrer.</div>'; return; }
  const tabSel = document.querySelector('#tabs [aria-selected="true"]')?.id?.slice(2);
  init();
  if(!wmxReady){ wmxReady = true; wmxInit(); } else { wmxFill(); }
  wpInit();
  if(tabSel) document.getElementById('t-'+tabSel)?.click();
}
document.querySelectorAll('.runbar button.run').forEach(b=>b.addEventListener('click', ()=>launch(b.dataset.mode)));
$('#xls').addEventListener('click', exportXlsx);
load();
