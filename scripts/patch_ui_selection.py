p = 'public/index.html'
s = open(p, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, old[:70]
    s = s.replace(old, new, 1)


rep("const TABS = [['soiree','Soirée du jour'],", "const TABS = [['selec','Sélection du soir'],['soiree','Soirée du jour'],")
rep("const views = {soiree, joueurs, equipes, blessures, veille, fiab, appr};", "const views = {selec, soiree, joueurs, equipes, blessures, veille, fiab, appr};")
rep("show(TABS.some(t=>t[0]===start) ? start : 'soiree');", "show(TABS.some(t=>t[0]===start) ? start : 'selec');")
rep("let start = 'soiree';", "let start = 'selec';")

css = """.pick{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:12px 14px;display:grid;gap:6px;min-width:0}
.pick .top{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.pick .rank{font-family:var(--f-display);font-weight:700;font-size:1.5rem;color:var(--muted);min-width:1.4em}
.pick .who{flex:1;min-width:0}
.pick .who b{font-family:var(--f-display);font-size:1.25rem;font-weight:700}
.pick .big{font-family:var(--f-display);font-weight:700;font-size:1.6rem}
.pick ul{margin:0;padding-left:18px;font-size:.84rem;color:var(--muted)}
.picks{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.method{background:var(--accent-soft);border-radius:6px;padding:12px 14px;font-size:.88rem;line-height:1.55}
.method p{margin:0 0 6px}
"""
rep("</style>\n\n<div class=\"wrap\">", css + "</style>\n\n<div class=\"wrap\">")

fn = r"""
// ---- Sélection du soir : les choix les plus solides, expliqués
function selec(){
  const S = D.selection;
  if(!S) return `<div class="empty">Sélection disponible après la prochaine analyse. Appuie sur « Lancer PRÉ-MATCH ».</div>`;
  const prov = D.games.some(g=>g.lineups && g.lineups.status==='non disponibles');
  const fiabChip = f => `<span class="chip ${f>=70?'good':f>=55?'warn':'bad'}">Fiabilité ${f}/100</span>`;
  const card = (p,i,key,lab) => `<article class="pick"><div class="top"><span class="rank">${i+1}</span><div class="who"><b>${esc(p.nom)}</b> <span class="sub">${esc(p.equipe)} contre ${esc(p.opp)} · ${esc(p.pos)}${p.ligne&&p.ligne!=='non disponible'?' · '+esc(p.ligne):''}</span></div><span class="big">${pct(p.prob)}</span></div>
    <div class="chips"><span class="chip">${lab}</span>${fiabChip(p.fiabilite)}${key==='p_point'?`<span class="chip">But ${pct(p.p_but)}</span>`:`<span class="chip">Point ${pct(p.p_point)}</span>`}</div>
    <ul>${p.raisons.map(r=>`<li>${esc(r)}</li>`).join('')}</ul></article>`;
  const team = (t,i) => `<article class="pick"><div class="top"><span class="rank">${i+1}</span><div class="who"><b>${esc(t.equipe)}</b> <span class="sub">contre ${esc(t.adversaire)} · ${esc(t.match)}</span></div><span class="big">${pct(t.prob)}</span></div>
    <div class="chips">${t.solide?'<span class="chip good">Signal solide</span>':'<span class="chip warn">À confirmer</span>'}<span class="chip">Confiance ${esc(t.confiance)}</span>${t.cote?`<span class="chip">Cote ${t.cote}</span>`:''}</div>
    <ul>${t.raisons.map(r=>`<li>${esc(r)}</li>`).join('')}</ul></article>`;
  const mini = (p) => `<li><b>${esc(p.nom)}</b> (${esc(p.equipe)}, ${esc(p.match)}) : ${esc(p.lecture)} Probabilité retenue : but ${pct(p.p_but)}, point ${pct(p.p_point)}.</li>`;
  return `<div class="section">
    <div class="method"><p><b>Comment je choisis.</b> Une série ne rend pas un but moins probable : chaque match repart de zéro. Ce qui compte, c'est <b>pourquoi</b> un joueur marque. Je juge donc d'abord son volume de tirs, qui est un signal stable, puis sa réussite au tir, que je ramène vers sa moyenne de carrière parce qu'elle varie surtout par chance.</p>
    <p>Résultat : un joueur qui marque à chaque match avec une réussite anormale n'est pas suivi aveuglément (« série flatteuse »). Un joueur qui tire beaucoup sans marquer est revalorisé (« malchanceux »). J'écarte aussi les joueurs incertains, ceux qui ont trop peu de matchs ou un temps de glace trop faible, et je prends au maximum 2 joueurs par équipe et 3 par match, pour qu'un match fermé ne fasse pas tout tomber.</p>
    ${prov?'<p><b>Provisoire :</b> certaines compositions nhl.com ne sont pas encore publiées. La PRÉ-MATCH du soir affinera la sélection.</p>':''}</div>
    <h2>5 joueurs les plus probables de faire un point</h2>
    ${S.points.length?`<div class="picks">${S.points.map((p,i)=>card(p,i,'p_point','Au moins 1 point')).join('')}</div>`:'<div class="empty">Aucun joueur ne passe les filtres de fiabilité ce soir.</div>'}
    <h2>5 buteurs les plus probables</h2>
    ${S.buts.length?`<div class="picks">${S.buts.map((p,i)=>card(p,i,'p_but','Au moins 1 but')).join('')}</div>`:'<div class="empty">Aucun joueur ne passe les filtres de fiabilité ce soir.</div>'}
    <h2>Équipes les plus sûres</h2>
    ${S.equipes.length?`<div class="picks">${S.equipes.map(team).join('')}</div>`:'<div class="empty">Aucun match à venir ce soir.</div>'}
    <div class="lines">
      <div class="col"><h2>Séries trompeuses</h2><p class="lead">Ils marquent plus que leurs tirs ne le justifient. Ne pas les choisir pour leur série.</p>${(S.pieges||[]).length?`<ul class="logic">${S.pieges.map(mini).join('')}</ul>`:'<div class="sub">Aucune ce soir.</div>'}</div>
      <div class="col"><h2>Malchanceux à surveiller</h2><p class="lead">Beaucoup de tirs, peu de buts : statistiquement, la réussite revient.</p>${(S.relance||[]).length?`<ul class="logic">${S.relance.map(mini).join('')}</ul>`:'<div class="sub">Aucun ce soir.</div>'}</div>
    </div>
  </div>`;
}
"""
rep("// ---- Apprentissage : journal critique quotidien", fn + "\n// ---- Apprentissage : journal critique quotidien")
open(p, 'w', encoding='utf-8').write(s)
print('ok')
