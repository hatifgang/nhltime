B = 'netlify/functions/lib/pipeline.mts'
s = open(B, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, old[:90]
    s = s.replace(old, new, 1)


# --- loi binomiale négative pour les tirs : P(X >= k)
rep("function fmtSec(s: any) {",
    """/** P(X >= k) pour une binomiale négative de moyenne lam et dispersion r (r grand = Poisson). */
function pAtLeastK(lam: number, k: number, r = 15) {
  const q = lam / (r + lam);
  let pk = (r / (r + lam)) ** r, cdf = 0;
  for (let i = 0; i < k; i++) { cdf += pk; pk = pk * (i + r) / (i + 1) * q; }
  return Math.max(0, 1 - cdf);
}

function fmtSec(s: any) {""")

# --- tirs attendus ce soir : volume du joueur x tirs concédés par l'adversaire (prudence 50 %) x temps de glace récent
rep("      const pkOpp = pkOf(opp);",
    """      const pkOpp = pkOf(opp);
      const saOf = (t: string) => { const c = ctx.sc[t], q = ctx.sp[t]; const n = c?.gamesPlayed || 0, w = n / (n + 15); return w * (c?.shotsAgainstPerGame ?? 30) + (1 - w) * (q?.shotsAgainstPerGame ?? 30); };
      const saVals = Object.values(ctx.sp).map((t: any) => t.shotsAgainstPerGame).filter((x: any) => x > 0);
      const saLg = saVals.length ? saVals.reduce((a: number, b: number) => a + b, 0) / saVals.length : 30;
      const shotF = clamp(1 + 0.5 * (saOf(opp) / saLg - 1), 0.88, 1.12);""")
rep("          pk_adv: r3(pkOpp * 100, 1), an_sec: Math.round(p.pp_sec || 0),",
    """          pk_adv: r3(pkOpp * 100, 1), an_sec: Math.round(p.pp_sec || 0),
          tirs_ce_soir: r3((p.s_rate || 0) * shotF * Math.sqrt((p.toi_eff || p.toi_sec || 1) / (p.toi_sec || p.toi_eff || 1)), 2),
          p_tirs2: r3(pAtLeastK((p.s_rate || 0) * shotF * Math.sqrt((p.toi_eff || p.toi_sec || 1) / (p.toi_sec || p.toi_eff || 1)), 2)),
          p_tirs3: r3(pAtLeastK((p.s_rate || 0) * shotF * Math.sqrt((p.toi_eff || p.toi_sec || 1) / (p.toi_sec || p.toi_eff || 1)), 3)),
          tirs_concedes_adv: r3(saOf(opp), 1),""")

# --- évaluation : tirs et combinés
rep("  const ids = [...new Set<number>(pending.map((p: any) => p.game_id))];",
    "  const ids = [...new Set<number>(pending.flatMap((p: any) => [p.game_id, ...(p.legs || []).map((l: any) => l.game_id)]))];")
rep("""    const box = boxes.get(p.game_id);
    if (!box || !FINAL.includes(box.gameState)) continue;
    const a = box.awayTeam, h = box.homeTeam;
    if (p.type === 'Sélection équipe') {""",
    """    const box = boxes.get(p.game_id);
    if (!box || !FINAL.includes(box.gameState)) continue;
    const a = box.awayTeam, h = box.homeTeam;
    if (p.legs) {   // combiné : gagné seulement si chaque joueur fait au moins 1 point
      const lb = p.legs.map((l: any) => boxes.get(l.game_id));
      if (lb.some((b: any) => !b || !FINAL.includes(b.gameState))) continue;
      const st = p.legs.map((l: any, i: number) => boxPlayers(lb[i]).get(l.player_id));
      p.resultat = st.some((x: any) => !x) ? 'N/J' : +st.every((x: any) => x.points > 0);
      p.legs_res = st.map((x: any) => x ? +(x.points > 0) : null);
      newly++;
      continue;
    }
    if (p.type === 'Sélection équipe') {""")
rep("      p.resultat = !st ? 'N/J' : (/but/i.test(p.type) ? +(st.goals > 0)",
    "      const tk = p.type.match(/tirs (\\d)\\+/);\n      p.resultat = !st ? 'N/J' : tk ? +((st.sog || 0) >= +tk[1]) : (/but/i.test(p.type) ? +(st.goals > 0)")

# --- sélection : tirs (objectif 80 %) et combiné
rep("      return { niveau: p.niveau, id: p.id,",
    "      return { p_tirs2: p.p_tirs2, p_tirs3: p.p_tirs3, niveau: p.niveau, id: p.id,")
rep("  return { points: pickTop('p_point'), buts: pickTop('p_but'), equipes, pieges, relance };",
    """  // Objectif 80 % : les tirs cadrés d'un gros tireur sont bien plus prévisibles qu'un point.
  const tirs: any[] = []; const tTeam: Record<string, number> = {};
  const tc = eligible.flatMap((p: any) => [
    p.p_tirs3 >= 0.8 ? { p, seuil: 3, prob: p.p_tirs3 } : null,
    p.p_tirs2 >= 0.85 && !(p.p_tirs3 >= 0.8) ? { p, seuil: 2, prob: p.p_tirs2 } : null,
  ].filter(Boolean)).sort((a: any, b: any) => b.prob - a.prob);
  for (const { p, seuil, prob } of tc) {
    if (tTeam[p.equipe]) continue;
    tTeam[p.equipe] = 1;
    tirs.push({ id: p.id, nom: p.nom, equipe: p.equipe, opp: p.opp, pos: p.pos, game_id: p.game_id, match: p.match, seuil, prob,
      raisons: [`${p.tirs_ce_soir} tirs attendus ce soir (${p.tirs_match_attendus} en moyenne, ${p.l10_tirs_match ?? '?'} sur ses 10 derniers matchs).`,
        `${p.opp} concède ${p.tirs_concedes_adv} tirs par match ; temps de glace ${p.toi_recent || p.toi || '?'}${p.toi_an ? `, dont ${p.toi_an} en avantage numérique` : ''}.`,
        `Au moins ${seuil} tirs cadrés : ${Math.round(prob * 100)} %. Pour comparaison, au moins 1 point : ${Math.round((p.p_point || 0) * 100)} %.`] });
    if (tirs.length === 5) break;
  }

  // Combiné de 2 joueurs (au moins 1 point chacun), dans deux matchs différents pour rester indépendants.
  const pts = pickTop('p_point');
  const pairs: any[] = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const x = pts[i], y = pts[j];
    if (x.game_id === y.game_id) continue;
    const p = x.prob * y.prob;
    pairs.push({ joueurs: [x, y].map(z => ({ id: z.id, nom: z.nom, equipe: z.equipe, opp: z.opp, game_id: z.game_id, match: z.match, prob: z.prob, niveau: z.niveau })),
      prob: r3(p), cote_juste: r3(1 / p, 2), deux_surs: x.niveau === 'Choix sûr' && y.niveau === 'Choix sûr' });
  }
  pairs.sort((a, b) => (b.deux_surs ? 1 : 0) - (a.deux_surs ? 1 : 0) || b.prob - a.prob);
  return { points: pts, buts: pickTop('p_but'), equipes, pieges, relance, tirs, combines: pairs.slice(0, 2) };""")
rep("""  for (const [list, typ] of [[selection.buts, 'Sélection but'], [selection.points, 'Sélection point']] as const) for (const p of list) newPreds.push({ ...sbase(p.game_id), type: typ, selection: p.nom, player_id: p.id, pos: p.pos, ligne: p.ligne, prob: p.prob, niveau: p.niveau });""",
    """  for (const [list, typ] of [[selection.buts, 'Sélection but'], [selection.points, 'Sélection point']] as const) for (const p of list) newPreds.push({ ...sbase(p.game_id), type: typ, selection: p.nom, player_id: p.id, pos: p.pos, ligne: p.ligne, prob: p.prob, niveau: p.niveau });
  for (const t of selection.tirs) newPreds.push({ ...sbase(t.game_id), type: `Sélection tirs ${t.seuil}+`, selection: t.nom, player_id: t.id, pos: t.pos, prob: t.prob });
  if (selection.combines[0]) { const c = selection.combines[0]; newPreds.push({ ...sbase(c.joueurs[0].game_id), type: 'Combiné point', selection: c.joueurs.map((j: any) => j.nom).join(' + '), legs: c.joueurs.map((j: any) => ({ game_id: j.game_id, player_id: j.id })), prob: c.prob }); }""")
rep("  for (const [k, typ] of [['point', 'Sélection point'], ['but', 'Sélection but'], ['equipe', 'Sélection équipe']] as const) {",
    "  for (const [k, typ] of [['point', 'Sélection point'], ['but', 'Sélection but'], ['equipe', 'Sélection équipe'], ['tirs', 'Sélection tirs'], ['combine', 'Combiné point']] as const) {")
rep("    const g = db.predictions.filter((p: any) => p.type === typ && (p.resultat === 0 || p.resultat === 1));",
    "    const g = db.predictions.filter((p: any) => p.type.startsWith(typ) && (p.resultat === 0 || p.resultat === 1));")
rep("return ['Vainqueur', 'But joueur', 'Passe joueur', 'Point joueur', 'Sélection équipe', 'Sélection but', 'Sélection point'].map(typ => {",
    "return ['Vainqueur', 'But joueur', 'Passe joueur', 'Point joueur', 'Sélection équipe', 'Sélection but', 'Sélection point', 'Sélection tirs 2+', 'Sélection tirs 3+', 'Combiné point'].map(typ => {")
open(B, 'w', encoding='utf-8').write(s)

# ------------------------------------------------------------------ page
P = 'public/index.html'
s = open(P, encoding='utf-8').read()
rep("""    <h2>5 buteurs les plus probables</h2>""",
    """    <h2>Combiné de 2 joueurs (cote visée ≈ 2)</h2>${bil(S.bilan?.combine)}
    <div class="method"><p>Une cote de 2 correspond à <b>50 % de chances</b>. Un combiné de deux joueurs à 75 % passe environ 56 % du temps (0,75 × 0,75) : il gagne un peu plus d'une fois sur deux, jamais 8 fois sur 10. Il ne vaut le coup que si la cote combinée de ton bookmaker dépasse la <b>cote juste</b> ci-dessous. Tape les cotes Winamax des deux joueurs pour le vérifier.</p></div>
    ${(S.combines||[]).length ? `<div class="picks">${S.combines.map((c,i)=>`<article class="pick" data-combo="${i}"><div class="top"><span class="rank">${i+1}</span><div class="who"><b>${c.joueurs.map(j=>esc(j.nom)).join(' + ')}</b> <span class="sub">${c.joueurs.map(j=>`${esc(j.equipe)} contre ${esc(j.opp)}`).join(' · ')}</span></div><span class="big">${pct(c.prob)}</span></div>
      <div class="chips">${c.deux_surs?'<span class="chip good">2 choix sûrs</span>':'<span class="chip warn">Contient un complément</span>'}<span class="chip">Cote juste ${c.cote_juste}</span>${c.joueurs.map(j=>`<span class="chip">${esc(j.nom.split(' ').slice(-1)[0])} ${pct(j.prob)}</span>`).join('')}</div>
      <div class="wmx"><div class="row">${c.joueurs.map((j,k)=>`<label>Cote Winamax ${esc(j.nom.split(' ').slice(-1)[0])}<input inputmode="decimal" data-leg="${k}" placeholder="ex. 1,42"></label>`).join('')}</div><div class="res sub">Tape les deux cotes « au moins 1 point ».</div></div></article>`).join('')}</div>` : '<div class="empty">Pas de combiné possible ce soir : il faut deux bons joueurs dans deux matchs différents.</div>'}
    <h2>Objectif 80 % : tirs cadrés</h2>${bil(S.bilan?.tirs)}
    <p class="lead">Pour viser 8 réussites sur 10, le marché des tirs cadrés est plus adapté que le point : un gros tireur qui prend 4 à 5 tirs par match en cadre au moins 2 ou 3 presque à chaque fois. Je ne montre que les joueurs à 80 % ou plus (85 % pour « 2 tirs et plus »), un seul par équipe. Vérifie que ton bookmaker propose ce pari.</p>
    ${(S.tirs||[]).length ? `<div class="picks">${S.tirs.map((t,i)=>`<article class="pick"><div class="top"><span class="rank">${i+1}</span><div class="who"><b>${esc(t.nom)}</b> <span class="sub">${esc(t.equipe)} contre ${esc(t.opp)} · ${esc(t.pos)}</span></div><span class="big">${pct(t.prob)}</span></div>
      <div class="chips"><span class="chip good">Au moins ${t.seuil} tirs cadrés</span></div><ul>${t.raisons.map(r=>`<li>${esc(r)}</li>`).join('')}</ul></article>`).join('')}</div>` : '<div class="empty">Aucun joueur n’atteint 80 % ce soir. Dans ce cas, mieux vaut ne rien forcer.</div>'}
    <h2>5 buteurs les plus probables</h2>""")
rep("""async function wmxSave(){""",
    """function comboCalc(box){
  const c = (D.selection?.combines||[])[+box.dataset.combo]; if(!c) return;
  const odds = [...box.querySelectorAll('[data-leg]')].map(i=>num(i.value));
  const out = box.querySelector('.res');
  if(odds.some(o=>!o)){ out.innerHTML = 'Tape les deux cotes « au moins 1 point ».'; return; }
  const cote = odds[0]*odds[1], ev = c.prob*cote - 1;
  out.innerHTML = `Cote combinée ${cote.toFixed(2)} (cote juste ${c.cote_juste}). ` + (ev >= 0.05 ? `<span class="chip good">Valeur : +${(ev*100).toFixed(0)} % d'espérance</span>` : ev <= -0.05 ? `<span class="chip bad">Cote trop basse : ${(ev*100).toFixed(0)} % d'espérance</span>` : `<span class="chip">À peu près juste</span>`) + `<br>Chances de gagner le combiné : ${pct(c.prob)}.`;
}
document.addEventListener('input', e => { const box = e.target.closest('[data-combo]'); if(box && e.target.dataset.leg!=null) comboCalc(box); });
async function wmxSave(){""")
open(P, 'w', encoding='utf-8').write(s)
print('ok')
