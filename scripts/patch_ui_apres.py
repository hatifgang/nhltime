p = 'public/index.html'
s = open(p, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, old[:70]
    s = s.replace(old, new, 1)


rep("['veille','Résultats de la veille'],", "['veille','Résultats de la veille'],['apres','Après-match'],")
rep("const views = {selec, soiree, joueurs, equipes, blessures, veille, fiab, appr};", "const views = {selec, soiree, joueurs, equipes, blessures, veille, apres, fiab, appr};")

fn = r"""
// ---- Après-match : ce qui a marché, ce qui a raté, et pourquoi
function apres(){
  const A = D.apres;
  if(!A || !(A.equipes||[]).length) return `<div class="empty">Pas encore d'après-match pour la soirée du ${frDate(D.meta.veille)}. Il se remplit à la MISE À JOUR du matin.</div>`;
  const games = [...new Set(A.equipes.map(t=>t.game_id))];
  const causeChip = c => `<span class="chip ${c==='Réussi'?'good':c==='Équipe muselée'?'warn':c==='Temps de glace réduit'||c==='N’a pas joué'?'bad':''}">${esc(c)}</span>`;
  const mmss = s => s==null ? 'n.d.' : `${Math.floor(s/60)}:${String(Math.round(s%60)).padStart(2,'0')}`;
  const tot = A.causes_30j.reduce((s,c)=>s+c.n,0);
  return `<div class="section">
    <div class="summary"><b>Soirée du ${frDate(A.date)} :</b> ${A.hauts.n ? `${A.hauts.reussis} sur ${A.hauts.n} joueurs annoncés à 60 % ou plus ont fait un point (${pct(A.hauts.reussis/A.hauts.n)}). Pour être juste, une série de prédictions à 65 % doit réussir environ 2 fois sur 3, et pas à chaque fois.` : 'aucun joueur annoncé à 60 % ou plus.'}</div>
    ${games.map(gid => {
      const T = A.equipes.filter(t=>t.game_id===gid);
      const J = A.joueurs.filter(x=>x.game_id===gid).sort((a,b)=>b.prob-a.prob);
      return `<article class="game"><div class="hd"><b style="color:var(--fg)">${T.map(t=>`${t.equipe} ${t.buts}`).join(' – ')}</b><span>buts attendus ${T.map(t=>t.xg).join(' – ')}</span></div>
        <div class="sub">${T.map(t=>`${t.equipe} : ${t.buts} but(s) pour ${t.xg} attendus, ${t.tirs ?? '?'} tirs${t.sv_adv!=null?`, gardien adverse ${Number(t.sv_adv).toFixed(3)} d'arrêts`:''}${t.buts <= t.xg-1.5 ? ' : <b>muselée</b>' : t.buts >= t.xg+1.5 ? ' : <b>a explosé</b>' : ''}`).join('<br>')}</div>
        ${J.length?table([['Joueur',x=>[`<b>${esc(x.nom)}</b> <span class="sub">${esc(x.equipe)}</span>`,x.nom]],['P(point)',x=>[P(x.prob,.6,.45),x.prob],1],['Résultat',x=>[x.res===1?'<span class="chip good">Point</span>':x.res===0?'<span class="chip bad">0 point</span>':'<span class="chip">N/J</span>',x.res]],
          ['Temps de glace',x=>[`${mmss(x.toi)} <span class="sub">/ ${mmss(x.toi_exp)}</span>`,x.toi],1],['Tirs',x=>[`${x.tirs ?? '?'} <span class="sub">/ ${x.tirs_exp ?? '?'}</span>`,x.tirs],1],['Cause',x=>[causeChip(x.cause),x.cause]]], J):''}
      </article>`; }).join('')}
    <h2>Pourquoi les points probables ratent (30 derniers jours)</h2>
    ${tot ? `<div class="chart">${A.causes_30j.map(c=>`<div style="display:grid;grid-template-columns:minmax(120px,30%) 1fr 48px;gap:8px;align-items:center;margin:4px 0;font-size:.84rem"><span>${esc(c.cause)}</span><span style="background:var(--surface-2);border-radius:3px;height:14px;display:block"><span style="display:block;height:14px;border-radius:3px;background:${c.cause==='Équipe muselée'?'var(--warn)':'var(--accent)'};width:${Math.round(c.part*100)}%"></span></span><b style="text-align:right">${Math.round(c.part*100)} %</b></div>`).join('')}<div class="sub">${tot} points manqués à 50 % ou plus. « Équipe muselée » : l'équipe a marqué 1 but ou moins, ou 1,5 de moins que prévu. « Pas impliqué » : l'équipe a marqué normalement, mais pas avec lui. Toi / prévu = temps de glace et tirs réels / attendus.</div></div>` : '<div class="empty">Pas encore assez de matchs analysés.</div>'}
    <p class="lead">Chaque après-match est gardé en mémoire (120 jours pour les joueurs, 180 pour les équipes). Il sert à réajuster le calcul : l'échelle des buts attendus, la dispersion des points (soirs « à paquets ») et le poids du temps de glace récent. Les ajustements apparaissent dans l'onglet Apprentissage.</p>
  </div>`;
}
"""
rep("// ---- Apprentissage : journal critique quotidien", fn + "\n// ---- Apprentissage : journal critique quotidien")
rep("const fmtP = (k,v) => ['home','b2b','inj','h2h','form','vthr'].includes(k) ? (v*100).toFixed(1)+' %' : k==='wm' ? Math.round(v*100)+' %' : Number(v).toFixed(2);",
    "const fmtP = (k,v) => v==null ? '—' : ['home','b2b','inj','h2h','form','vthr'].includes(k) ? (v*100).toFixed(1)+' %' : k==='wm' ? Math.round(v*100)+' %' : Number(v).toFixed(2);")
open(p, 'w', encoding='utf-8').write(s)
print('ok')
