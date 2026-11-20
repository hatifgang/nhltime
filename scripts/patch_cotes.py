B = 'netlify/functions/lib/pipeline.mts'
s = open(B, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, old[:90]
    s = s.replace(old, new, 1)


rep("import { W, S, get, safe, pool, nm, r3, clamp, norm,", "import { poisson, W, S, get, safe, pool, nm, r3, clamp, norm,")
rep("      mL = { ...marketLambdas(line, pOver, mkt), line, pOver };", "      mL = { ...marketLambdas(line, pOver, mkt), line, pOver, dO, dU };")
rep("      game.pro = { verdict,",
    """      if (mL) {
        let c = 0; for (let k = 0; k <= Math.floor(mL.line); k++) c += poisson(k, pr.lh + pr.la);
        game.ou = { line: mL.line, cote_over: r3(mL.dO, 2), cote_under: r3(mL.dU, 2), p_over: r3(1 - c), p_under: r3(c) };
      }
      game.pro = { verdict,""")

# ---------- évaluation générique des jambes (combinés, paris fun, cotes 2+)
rep("""      const st = p.legs.map((l: any, i: number) => boxPlayers(lb[i]).get(l.player_id));
      p.resultat = st.some((x: any) => !x) ? 'N/J' : +st.every((x: any) => x.points > 0);
      p.legs_res = st.map((x: any) => x ? +(x.points > 0) : null);""",
    """      const res = p.legs.map((l: any, i: number) => gradeLeg(l, lb[i]));
      p.resultat = res.some((x: any) => x == null) ? 'N/J' : +res.every((x: any) => x === 1);
      p.legs_res = res;""")
rep("/** Bilan des signaux :",
    """/** Une jambe de pari : 1 gagnée, 0 perdue, null si le joueur n'a pas joué. */
function gradeLeg(l: any, box: any) {
  const a = box.awayTeam, h = box.homeTeam, tot = a.score + h.score;
  const lp = box.gameOutcome?.lastPeriodType || box.periodDescriptor?.periodType || 'REG';
  const kind = l.kind || 'point';
  if (kind === 'win') return +((a.score > h.score ? a.abbrev : h.abbrev) === l.team);
  if (kind === 'reg') { if (lp !== 'REG') return +(l.team === 'nul'); return +(l.team !== 'nul' && (a.score > h.score ? a.abbrev : h.abbrev) === l.team); }
  if (kind === 'over') return tot === l.line ? null : +(tot > l.line);
  if (kind === 'under') return tot === l.line ? null : +(tot < l.line);
  const st = boxPlayers(box).get(l.player_id);
  if (!st) return null;
  if (kind === 'point') return +(st.points > 0);
  if (kind === '2pts') return +(st.points >= 2);
  if (kind === 'but') return +(st.goals > 0);
  if (kind === '2buts') return +(st.goals >= 2);
  if (kind === 'tirs2') return +((st.sog || 0) >= 2);
  return null;
}

/** Bilan des signaux :""")

# ---------- sélection : cotes 2+, paris fun, accord avec les autres parieurs
rep("  const selection = buildSelection(outGames, outPlayers, startedIds);",
    "  const selection = buildSelection(outGames, outPlayers, startedIds, signalBilan(db));")
rep("function buildSelection(games: any[], players: any[], started: Set<number>) {",
    "function buildSelection(games: any[], players: any[], started: Set<number>, signaux: any[] = []) {")
rep("  return { points: pts, buts: pickTop('p_but'), equipes, pieges, relance, tirs, combines: pairs.slice(0, 2),",
    """  // ---- Réservoir de « jambes » : chaque pari simple possible ce soir, avec ma probabilité et sa cote (marché si connue)
  const legs: any[] = [];
  const live = games.filter(g => !started.has(g.game_id));
  for (const g of live) {
    const m = `${g.exterieur} @ ${g.domicile}`;
    if (g.cote_dom) legs.push({ kind: 'win', team: g.domicile, game_id: g.game_id, label: `${g.domicile} gagne (prolongation incluse)`, match: m, prob: g.p_dom, cote: g.cote_dom, marche: true });
    if (g.cote_ext) legs.push({ kind: 'win', team: g.exterieur, game_id: g.game_id, label: `${g.exterieur} gagne (prolongation incluse)`, match: m, prob: g.p_ext, cote: g.cote_ext, marche: true });
    if (g.cote1x2) {
      legs.push({ kind: 'reg', team: g.domicile, game_id: g.game_id, label: `${g.domicile} gagne en 60 min`, match: m, prob: g.p_reg_dom, cote: g.cote1x2.dom, marche: true });
      legs.push({ kind: 'reg', team: g.exterieur, game_id: g.game_id, label: `${g.exterieur} gagne en 60 min`, match: m, prob: g.p_reg_ext, cote: g.cote1x2.ext, marche: true });
      legs.push({ kind: 'reg', team: 'nul', game_id: g.game_id, label: `Match nul après 60 min`, match: m, prob: g.p_nul_reg, cote: g.cote1x2.nul, marche: true });
    }
    if (g.ou) {
      legs.push({ kind: 'over', line: g.ou.line, game_id: g.game_id, label: `Plus de ${g.ou.line} buts`, match: m, prob: g.ou.p_over, cote: g.ou.cote_over, marche: true });
      legs.push({ kind: 'under', line: g.ou.line, game_id: g.game_id, label: `Moins de ${g.ou.line} buts`, match: m, prob: g.ou.p_under, cote: g.ou.cote_under, marche: true });
    }
  }
  for (const p of eligible) {
    const base = { player_id: p.id, game_id: p.game_id, match: p.match, marche: false };
    if (p.p_point >= 0.55) legs.push({ ...base, kind: 'point', label: `${p.nom} : au moins 1 point`, prob: p.p_point, cote: r3(1 / p.p_point, 2) });
    if (p.p_point2 >= 0.3) legs.push({ ...base, kind: '2pts', label: `${p.nom} : 2 points ou plus`, prob: p.p_point2, cote: r3(1 / p.p_point2, 2) });
    if (p.p_but >= 0.35) legs.push({ ...base, kind: 'but', label: `${p.nom} : marque un but`, prob: p.p_but, cote: r3(1 / p.p_but, 2) });
  }

  // ---- Meilleurs paris à cote 2 ou plus : seulement ceux où la cote réelle dépasse ce que vaut le pari selon moi
  const cote2 = legs.filter(l => l.marche && l.cote >= 2 && l.prob * l.cote - 1 >= 0.03)
    .map(l => ({ ...l, ev: r3(l.prob * l.cote - 1, 3), cote_juste: r3(1 / l.prob, 2) }))
    .sort((x, y) => y.ev - x.ev).slice(0, 5);
  // et les meilleures cotes justes ≥ 2 côté joueurs (à jouer seulement si Winamax paie au moins cette cote)
  const cote2j = legs.filter(l => !l.marche && l.cote >= 2).sort((x, y) => y.prob - x.prob).slice(0, 4);

  // ---- Pari fun : combinaison la plus probable qui atteint la cote visée, un pari par match (indépendance)
  const funSearch = (target: number, maxLegs: number) => {
    const pool = [...legs].sort((x, y) => y.prob - x.prob).slice(0, 22);
    let best: any = null;
    const rec = (start: number, chosen: any[], prob: number, cote: number) => {
      if (cote >= target && chosen.length >= 2) { if (!best || prob > best.prob) best = { legs: [...chosen], prob, cote }; return; }
      if (chosen.length === maxLegs) return;
      for (let i = start; i < pool.length; i++) {
        const l = pool[i];
        if (chosen.some(c => c.game_id === l.game_id)) continue;
        if (best && prob * l.prob <= best.prob) continue;   // ne peut plus faire mieux
        chosen.push(l); rec(i + 1, chosen, prob * l.prob, cote * l.cote); chosen.pop();
      }
    };
    rec(0, [], 1, 1);
    return best ? { cible: target, prob: r3(best.prob, 3), cote: r3(best.cote, 2), cote_juste: r3(1 / best.prob, 2),
      legs: best.legs.map((l: any) => ({ kind: l.kind, team: l.team, line: l.line, player_id: l.player_id, game_id: l.game_id, label: l.label, match: l.match, prob: l.prob, cote: l.cote, marche: l.marche })) } : null;
  };
  const fun = [funSearch(5, 4), funSearch(10, 5)].filter(Boolean);

  // ---- Accord avec les autres parieurs : mon favori + leaders Covers (+ marché), leur poids dépend de leur preuve
  const lead = signaux.find((x: any) => /Leaders Covers \\(/.test(x.signal));
  const accord = live.filter(g => g.parieurs?.leaders_pick).map(g => {
    const fav = g.p_dom >= g.p_ext ? g.domicile : g.exterieur, p = Math.max(g.p_dom, g.p_ext);
    const agree = g.parieurs.leaders_pick === fav;
    const bonus = agree && lead?.prouve ? r3(Math.min(0.05, (lead.taux - 0.5) / 2), 3) : 0;
    return { game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, equipe: fav, accord: agree, prob: p, prob_mixte: r3(Math.min(0.95, p + bonus), 3),
      leaders: `${g.parieurs.leaders_ext}–${g.parieurs.leaders_dom}`, public: g.parieurs.public_dom != null ? `${g.parieurs.public_ext}–${g.parieurs.public_dom} %` : null,
      cote: fav === g.domicile ? g.cote_dom : g.cote_ext, poids: lead?.prouve ? 'prouvé' : `en observation (${lead?.n ?? 0}/30 matchs)` };
  }).sort((x, y) => (y.accord ? 1 : 0) - (x.accord ? 1 : 0) || y.prob_mixte - x.prob_mixte);

  return { cote2, cote2j, fun, accord, points: pts, buts: pickTop('p_but'), equipes, pieges, relance, tirs, combines: pairs.slice(0, 2),""")
rep("  for (const t of selection.tirs) newPreds.push(",
    """  for (const c of selection.cote2) newPreds.push({ ...sbase(c.game_id), v: 2, type: 'Cote 2+', selection: c.label, legs: [{ kind: c.kind, team: c.team, line: c.line, game_id: c.game_id }], prob: c.prob, cote: c.cote, prob_implicite: r3(1 / c.cote), valeur: 'Valeur potentielle' });
  for (const f of selection.fun) newPreds.push({ ...sbase(f.legs[0].game_id), v: 2, type: `Pari fun ${f.cible}+`, selection: f.legs.map((l: any) => l.label).join(' + '), legs: f.legs.map((l: any) => ({ kind: l.kind, team: l.team, line: l.line, player_id: l.player_id, game_id: l.game_id })), prob: f.prob, cote: f.cote });
  for (const t of selection.tirs) newPreds.push(""")
rep("'Sélection 2+ points', 'Sélection 2+ buts', 'Lecture pro'].map(typ => {",
    "'Sélection 2+ points', 'Sélection 2+ buts', 'Lecture pro', 'Cote 2+', 'Pari fun 5+', 'Pari fun 10+'].map(typ => {")
rep("['deux_points', 'Sélection 2+'], ['pro', 'Lecture pro']] as const) {",
    "['deux_points', 'Sélection 2+'], ['pro', 'Lecture pro'], ['cote2', 'Cote 2+'], ['fun', 'Pari fun']] as const) {")
# le combiné du soir doit aussi utiliser la nouvelle évaluation (jambes « point »)
open(B, 'w', encoding='utf-8').write(s)

# ================================================================== page
P = 'public/index.html'
s = open(P, encoding='utf-8').read()
rep("    <h2>Combiné de 2 joueurs (cote visée ≈ 2)</h2>",
    """    <h2>Meilleurs paris à cote 2 ou plus</h2>${bil(S.bilan?.cote2)}
    <p class="lead">Seulement les paris où la cote affichée par nhl.com (DraftKings) paie plus que ce que vaut le pari selon moi. L'espérance est le gain moyen par euro misé sur la durée. Gagner moins d'une fois sur deux est normal à ces cotes : c'est la cote qui compense.</p>
    ${(S.cote2||[]).length ? table([['Pari',c=>[`<b>${esc(c.label)}</b> <span class="sub">${esc(c.match)}</span>`,c.label]],['Cote',c=>[c.cote,c.cote],1],['Mes chances',c=>[pct(c.prob),c.prob],1],['Cote juste',c=>[c.cote_juste,c.cote_juste],1],['Espérance',c=>[`<span class="chip good">+${Math.round(c.ev*100)} %</span>`,c.ev],1],['Mise conseillée',c=>[kellyTxt(c.prob,c.cote).replace(' · Mise conseillée : ','')||'—',c.ev],1]], S.cote2) : '<div class="empty">Aucune cote de 2 ou plus n’a de valeur ce soir (ou les cotes ne sont pas encore publiées). Ne pas forcer.</div>'}
    ${(S.cote2j||[]).length ? `<p class="lead">Côté joueurs (pas de cote publiée par nhl.com) : à jouer seulement si Winamax paie au moins la cote juste.</p><ul class="logic">${S.cote2j.map(l=>`<li><b>${esc(l.label)}</b> (${esc(l.match)}) : ${pct(l.prob)}, cote juste ${l.cote}</li>`).join('')}</ul>` : ''}
    <h2>Pari fun du soir</h2>${bil(S.bilan?.fun)}
    <p class="lead">Pour le plaisir et le risque assumé. Je cherche la combinaison qui a le plus de chances d'atteindre la cote visée, avec un seul pari par match. Ça reste un pari qui perd la plupart du temps : petite mise seulement (1 % de ta bankroll au maximum).</p>
    ${(S.fun||[]).length ? `<div class="picks">${S.fun.map(f=>`<article class="pick"><div class="top"><div class="who"><b>Cote ${f.cible}+ : ${f.cote}</b> <span class="sub">${f.legs.length} paris combinés</span></div><span class="big">${pct(f.prob)}</span></div>
      <div class="chips"><span class="chip warn">Risqué</span><span class="chip">Chance de gagner : environ 1 sur ${Math.round(1/f.prob)}</span><span class="chip">Cote juste ${f.cote_juste}</span></div>
      <ul>${f.legs.map(l=>`<li>${esc(l.label)} <span class="sub">(${esc(l.match)}) ${pct(l.prob)} · cote ${l.cote}${l.marche?'':' juste'}</span></li>`).join('')}</ul>
      <div class="sub">Cote calculée avec les cotes nhl.com pour les équipes et les cotes justes pour les joueurs : chez Winamax, le combiné paiera un peu moins. Vérifie qu'il dépasse ${f.cote_juste}.</div></article>`).join('')}</div>` : '<div class="empty">Pas assez de paris solides ce soir pour construire un pari fun.</div>'}
    <h2>Accord avec les autres parieurs</h2>
    <p class="lead">Mon favori et celui des leaders Covers. Leur avis ne modifie mes chances qu'une fois prouvé sur au moins 30 matchs (onglet Apprentissage) ; avant ça, l'accord sert seulement d'indice.</p>
    ${(S.accord||[]).length ? table([['Match',a=>[esc(a.match),a.match]],['Mon favori',a=>[`<b>${esc(a.equipe)}</b>`,a.equipe]],['Leaders (ext–dom)',a=>[esc(a.leaders),a.leaders]],['Public (ext–dom)',a=>[esc(a.public||'—'),a.public]],['Accord',a=>[a.accord?'<span class="chip good">D\\'accord</span>':'<span class="chip bad">Désaccord</span>',a.accord?1:0]],['Mes chances',a=>[pct(a.prob),a.prob],1],['Chances mixtes',a=>[pct(a.prob_mixte),a.prob_mixte],1],['Poids des leaders',a=>[esc(a.poids),a.poids]]], S.accord) : '<div class="empty">Pas de données Covers ce soir.</div>'}
    <h2>Combiné de 2 joueurs (cote visée ≈ 2)</h2>""")
open(P, 'w', encoding='utf-8').write(s)
print('ok')
