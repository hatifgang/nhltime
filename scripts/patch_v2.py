B = 'netlify/functions/lib/'


def patch(path, pairs):
    s = open(B + path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (path, old[:90])
        s = s.replace(old, new, 1)
    open(B + path, 'w', encoding='utf-8').write(s)


# ================================================================== model.mts
patch('model.mts', [
    ("  as: number; rs: number; // échelle et dispersion des tirs cadrés joueurs, apprises sur les tirs réels\n}",
     "  as: number; rs: number; // échelle et dispersion des tirs cadrés joueurs, apprises sur les tirs réels\n"
     "  wt: number;     // poids du marché (cote du total de buts + vainqueur) dans les buts attendus de chaque équipe\n"
     "  wi: number;     // poids du modèle « part des buts sur la glace » dans les points joueurs\n}"),
    ("  rs: { v: 8, sd: 0.6, min: 1.5, max: 60, label: 'Dispersion des tirs cadrés joueurs' },",
     "  rs: { v: 8, sd: 0.6, min: 1.5, max: 60, label: 'Dispersion des tirs cadrés joueurs' },\n"
     "  wt: { v: 0.6, sd: 0.2, min: 0, max: 1, label: 'Poids du marché dans les buts attendus' },\n"
     "  wi: { v: 0.5, sd: 0.2, min: 0, max: 1, label: 'Poids du modèle sur la glace (points joueurs)' },"),
    ("  mkt_h: number | null;          // probabilité marché sans marge (domicile, prolongation incluse)\n}",
     "  mkt_h: number | null;          // probabilité marché sans marge (domicile, prolongation incluse)\n"
     "  mkt_lh?: number | null; mkt_la?: number | null; // buts attendus déduits des cotes (total + vainqueur)\n}"),
    ("  lh *= 1 + p.h2h * f.h2h; la *= 1 - p.h2h * f.h2h;\n",
     "  lh *= 1 + p.h2h * f.h2h; la *= 1 - p.h2h * f.h2h;\n"
     "  // Le marché des totaux est très efficace : on mêle (moyenne géométrique) nos buts attendus et les siens.\n"
     "  const wt = p.wt ?? 0;\n"
     "  if (f.mkt_lh && f.mkt_la && wt > 0) { lh = Math.exp((1 - wt) * Math.log(lh) + wt * Math.log(f.mkt_lh)); la = Math.exp((1 - wt) * Math.log(la) + wt * Math.log(f.mkt_la)); }\n"),
    ("export const pAtLeastOne = (lam: number) =>",
     """/** Probabilité de victoire domicile (prolongation incluse) pour des buts attendus donnés. */
export function homeWinProb(lh: number, la: number) {
  let ph = 0, pt = 0;
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) { const q = poisson(i, lh) * poisson(j, la); if (i > j) ph += q; else if (i === j) pt += q; }
  return ph + pt * clamp(0.5 + 0.5 * (lh - la) / (lh + la), 0.4, 0.6);
}
/** Buts attendus implicites du marché : le total vient de la cote plus/moins, la répartition de la cote vainqueur. */
export function marketLambdas(line: number, pOver: number, pHome: number) {
  const over = (mu: number) => { let c = 0; for (let k = 0; k <= Math.floor(line); k++) c += poisson(k, mu); return 1 - c; };
  let lo = 2, hi = 12;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (over(m) < pOver) lo = m; else hi = m; }
  const mu = (lo + hi) / 2;
  let a = 0.25, b = 0.75;
  for (let i = 0; i < 40; i++) { const s = (a + b) / 2; if (homeWinProb(s * mu, (1 - s) * mu) < pHome) a = s; else b = s; }
  const s = (a + b) / 2;
  return { lh: s * mu, la: (1 - s) * mu, total: mu };
}

export const pAtLeastOne = (lam: number) =>"""),
])

# ================================================================== pipeline.mts
patch('pipeline.mts', [
    ("import { gameProbs, defaultParams, pNB, pAtLeastK, calibrate, PRIORS, type Params, type GameFeat } from './model.mts';",
     "import { gameProbs, defaultParams, pNB, pAtLeastK, calibrate, marketLambdas, PRIORS, type Params, type GameFeat } from './model.mts';"),
    # contexte : buts sur la glace des joueurs
    ("  const [teamsList, standings, sumCur, sumPrev, skCur, skPrev, toiCur, gkCur, gkPrev] = await Promise.all([",
     "  const [teamsList, standings, sumCur, sumPrev, skCur, skPrev, toiCur, gkCur, gkPrev, onCur, onPrev] = await Promise.all(["),
    ("    safe(`${S}/goalie/summary?limit=-1&${q(prev)}`, { data: [] as any[] }),",
     "    safe(`${S}/goalie/summary?limit=-1&${q(prev)}`, { data: [] as any[] }),\n"
     "    safe(`${S}/skater/goalsForAgainst?limit=-1&${q(cur)}`, { data: [] as any[] }),\n"
     "    safe(`${S}/skater/goalsForAgainst?limit=-1&${q(prev)}`, { data: [] as any[] }),"),
    ("  return { today, cur, prev, consulted, st, abbrs, sc, sp, sched, nickUpper, league,",
     "  // réussite au tir de la ligue (pour juger les équipes sur leurs tirs, moins soumis à la chance que les buts)\n"
     "  const shotsAll = Object.values(sp).reduce((s: number, t: any) => s + t.shotsForPerGame * t.gamesPlayed, 0);\n"
     "  const lgSh = shotsAll ? gfp / shotsAll : 0.1;\n"
     "  return { today, cur, prev, consulted, st, abbrs, sc, sp, sched, nickUpper, league, lgSh, onCur: byId(onCur.data), onPrev: byId(onPrev.data),"),
    # force des équipes : buts ET tirs
    ("""  const gf = w * (c.goalsForPerGame ?? lg) + (1 - w) * (p.goalsForPerGame ?? lg), ga = w * (c.goalsAgainstPerGame ?? lg) + (1 - w) * (p.goalsAgainstPerGame ?? lg);
  // Les écarts observés entre équipes exagèrent les écarts réels (chance, calendrier) : on en garde 70 %.
  const R = 0.7;
  return { gf: lg + R * (gf - lg), ga: lg + R * (ga - lg), n };""",
     """  const gf = w * (c.goalsForPerGame ?? lg) + (1 - w) * (p.goalsForPerGame ?? lg), ga = w * (c.goalsAgainstPerGame ?? lg) + (1 - w) * (p.goalsAgainstPerGame ?? lg);
  // Les tirs disent mieux la force réelle que les buts (moins de chance) : moitié buts, moitié tirs x réussite moyenne.
  const ws = n / (n + 6);
  const sf = ws * (c.shotsForPerGame ?? 0) + (1 - ws) * (p.shotsForPerGame ?? 0), sa = ws * (c.shotsAgainstPerGame ?? 0) + (1 - ws) * (p.shotsAgainstPerGame ?? 0);
  const gfS = sf ? sf * ctx.lgSh : gf, gaS = sa ? sa * ctx.lgSh : ga;
  const gfB = 0.5 * gf + 0.5 * gfS, gaB = 0.5 * ga + 0.5 * gaS;
  // Les écarts observés entre équipes exagèrent les écarts réels (chance, calendrier) : on en garde 75 %.
  const R = 0.75;
  return { gf: lg + R * (gfB - lg), ga: lg + R * (gaB - lg), n, gfRaw: gf };"""),
    # cotes du total de buts
    ("    const mkt = mlA && mlH ? (1 / mlH) / (1 / mlA + 1 / mlH) : null;\n    const feat: GameFeat = {",
     """    const mkt = mlA && mlH ? (1 / mlH) / (1 / mlA + 1 / mlH) : null;
    const ouAll = !started ? [...(o?.homeTeam?.odds || []), ...(o?.awayTeam?.odds || [])].filter((x: any) => x.description === 'OVER_UNDER') : [];
    const ov = ouAll.find((x: any) => /^O/.test(x.qualifier)), un = ouAll.find((x: any) => /^U/.test(x.qualifier));
    let mL: any = null;
    if (ov && un && mkt != null && ov.qualifier.slice(1) === un.qualifier.slice(1)) {
      const line = parseFloat(ov.qualifier.slice(1)), dO = americanToDecimal(ov.value)!, dU = americanToDecimal(un.value)!;
      const pOver = (1 / dO) / (1 / dO + 1 / dU);
      mL = { ...marketLambdas(line, pOver, mkt), line, pOver };
    }
    const feat: GameFeat = {"""),
    ("inj_h: ih.ratio, inj_a: ia.ratio, h2h, mkt_h: mkt };",
     "inj_h: ih.ratio, inj_a: ia.ratio, h2h, mkt_h: mkt, mkt_lh: mL ? r3(mL.lh, 3) : null, mkt_la: mL ? r3(mL.la, 3) : null };\n"
     "    const prModel = gameProbs({ ...feat, mkt_lh: null, mkt_la: null }, params);"),
]);

s = open(B + 'pipeline.mts', encoding='utf-8').read()
# logique : afficher le total du marché
old = "    if (mkt != null) facts.push(`Modèle seul ${h} ${Math.round(pr.model_h * 100)} % ; marché ${Math.round(mkt * 100)} % ; retenu ${Math.round(pH * 100)} % (poids du modèle appris : ${Math.round(params.wm * 100)} %)`);"
assert old in s
s = s.replace(old, old + "\n    if (mL) facts.push(`Cote du total : ${mL.line} buts (plus : ${Math.round(mL.pOver * 100)} %) → le marché attend ${mL.lh.toFixed(2)}–${mL.la.toFixed(2)} (domicile–extérieur). Mon modèle : ${prModel.lh.toFixed(2)}–${prModel.la.toFixed(2)}. Retenu : ${pr.lh.toFixed(2)}–${pr.la.toFixed(2)} (poids du marché ${Math.round(params.wt * 100)} %).`);", 1)
open(B + 'pipeline.mts', 'w', encoding='utf-8').write(s)

patch('pipeline.mts', [
    # joueurs : modèle « sur la glace » (part des buts de l'équipe quand il joue x part des buts où il obtient un point)
    ("        const pp_sec = ctx.toi.get(s.id)?.ppTimeOnIcePerGame || 0;",
     """        const pp_sec = ctx.toi.get(s.id)?.ppTimeOnIcePerGame || 0;
        const oc = ctx.onCur.get(s.id), op = ctx.onPrev.get(s.id);
        const onGF = (x: any) => x ? (x.evenStrengthGoalsFor || 0) + (x.powerPlayGoalFor || 0) + (x.shortHandedGoalsFor || 0) : 0;
        const ocg = oc?.gamesPlayed || 0, opg = op?.gamesPlayed || 0;
        const onTot = onGF(oc) + onGF(op);
        // IPP : part des buts marqués avec lui sur la glace où il obtient un point (stable, ramenée vers la moyenne du poste)
        const ipp = (((c?.points || 0) + (p?.points || 0)) + (isD ? 0.42 : 0.68) * 30) / (onTot + 30);
        const priorOn = ctx.league * Math.min(0.6, (toi_sec || (isD ? 1200 : 900)) / 3600);
        const onPg = blendRate(ocg, ocg ? onGF(oc) / ocg : 0, opg, opg ? onGF(op) / opg : 0, 10, priorOn);"""),
    ("g_rate, a_rate, p_rate, s_rate, sh_true, toi_sec, pp_share, pp_sec };",
     "g_rate, a_rate, p_rate, s_rate, sh_true, toi_sec, pp_share, pp_sec, ipp, onPg };"),
    ("    for (const [ab, opp, tl, lamT, gfT] of [[a, h, L?.away, pr.la, ra.gf], [h, a, L?.home, pr.lh, rh.gf]] as const) {",
     "    for (const [ab, opp, tl, lamT, gfT, gfRawT] of [[a, h, L?.away, pr.la, ra.gf, ra.gfRaw], [h, a, L?.home, pr.lh, rh.gf, rh.gfRaw]] as const) {"),
    ("      const ppm = (p: any) => 1 + (p.pp_share || 0) * (pkF - 1);",
     "      const ppm = (p: any) => 1 + (p.pp_share || 0) * (pkF - 1);\n"
     "      // Points via la glace : buts attendus de l'équipe ce soir x sa part des buts sur la glace x son IPP.\n"
     "      const lamIpp = (p: any) => (lamT / params.xg) * Math.min(0.75, p.onPg / Math.max(1.5, gfRawT)) * p.ipp * ppm(p) * (p.toi_eff && p.toi_sec ? clamp(Math.sqrt(p.toi_eff / p.toi_sec), 0.85, 1.12) : 1);\n"
     "      const lamOld = (p: any) => p.p_rate * teamF / params.xg * ppm(p);\n"
     "      const lamPts = (p: any) => (1 - params.wi) * lamOld(p) + params.wi * lamIpp(p);"),
    ("lam_point: p.p_rate * teamF / params.xg * ppm(p), xg_team: r3(lamT, 2),",
     "lam_point: lamPts(p), lam_old: lamOld(p), lam_ipp: lamIpp(p), xg_team: r3(lamT, 2), ipp_pct: r3(p.ipp * 100, 0), part_glace: r3(100 * Math.min(0.75, p.onPg / Math.max(1.5, gfRawT)), 0),"),
    ("regular(p, pNB(p.p_rate * teamF / params.xg * ppm(p) * params.ap, params.rp))",
     "regular(p, pNB(lamPts(p) * params.ap, params.rp))"),
    # prédictions : on garde les deux estimations pour apprendre leur poids
    ("prob: pl[pk], lam_base: r3(pl[lk], 4), cote: null, prob_implicite: null, valeur: null, equipe: pl.equipe,",
     "prob: pl[pk], lam_base: r3(pl[lk], 4), ...(typ === 'Point joueur' ? { lam_old: r3(pl.lam_old, 4), lam_ipp: r3(pl.lam_ipp, 4) } : {}), cote: null, prob_implicite: null, valeur: null, equipe: pl.equipe,"),
    ("xg_dom: game.buts_attendus_dom, xg_ext: game.buts_attendus_ext, xg_scale: params.xg });",
     "xg_dom: game.buts_attendus_dom, xg_ext: game.buts_attendus_ext, xg_scale: params.xg, xgm_dom: game.xgm_dom, xgm_ext: game.xgm_ext, xgk_dom: feat.mkt_lh ?? null, xgk_ext: feat.mkt_la ?? null });"),
    ("      buts_attendus_ext: r3(pr.la, 2), buts_attendus_dom: r3(pr.lh, 2),",
     "      buts_attendus_ext: r3(pr.la, 2), buts_attendus_dom: r3(pr.lh, 2), xgm_dom: r3(prModel.lh, 3), xgm_ext: r3(prModel.la, 3), total_marche: mL ? mL.line : null,"),
    # après-match : garder modèle et marché séparément
    ("      { date: p.date, game_id: p.game_id, equipe: h.abbrev, adversaire: a.abbrev, xg: xd, xg_scale: sc, buts: h.score, tirs: h.sog, sv_adv: svOf('awayTeam') },\n"
     "      { date: p.date, game_id: p.game_id, equipe: a.abbrev, adversaire: h.abbrev, xg: xe, xg_scale: sc, buts: a.score, tirs: a.sog, sv_adv: svOf('homeTeam') },",
     "      { date: p.date, game_id: p.game_id, equipe: h.abbrev, adversaire: a.abbrev, xg: xd, xg_scale: sc, xgm: p.xgm_dom ?? null, xgk: p.xgk_dom ?? null, buts: h.score, tirs: h.sog, sv_adv: svOf('awayTeam') },\n"
     "      { date: p.date, game_id: p.game_id, equipe: a.abbrev, adversaire: h.abbrev, xg: xe, xg_scale: sc, xgm: p.xgm_ext ?? null, xgk: p.xgk_ext ?? null, buts: a.score, tirs: a.sog, sv_adv: svOf('homeTeam') },"),
    # raisons dans la sélection
    ("      if (p.pp_sec) why.push(`Avantage numérique :",
     "      if (p.ipp_pct != null) why.push(`Sur la glace : il est présent sur ${p.part_glace} % des buts de son équipe et obtient un point sur ${p.ipp_pct} % de ceux-là.`);\n"
     "      if (p.pp_sec) why.push(`Avantage numérique :"),
])

# ================================================================== learn.mts : apprendre wt et wi
patch('learn.mts', [
    ("  // 2b. Buts attendus des équipes contre buts réellement marqués (après-match)",
     """  // 2c. Poids du marché dans les buts attendus : vraisemblance des buts réellement marqués
  const tk = (db.postmatch?.teams || []).filter((t: any) => t.xgm > 0 && t.xgk > 0);
  if (tk.length >= 40) {
    const P = PRIORS.wt;
    const nllT = (w: number) => tk.reduce((s: number, t: any) => { const lam = Math.exp((1 - w) * Math.log(t.xgm) + w * Math.log(t.xgk)) * (params.xg / (t.xg_scale || 1)); return s + lam - t.buts * Math.log(lam); }, 0);
    let bw = P.v, bv = Infinity;
    for (let w = 0; w <= 1.0001; w += 0.02) { const v = nllT(w) + (w - P.v) ** 2 / (2 * P.sd ** 2); if (v < bv) { bv = v; bw = w; } }
    const gain = nllT(P.v) - nllT(bw);
    const target = r3(gain >= LR[1] ? bw : P.v, 2)!;
    if (Math.abs(target - prevParams.wt) >= 0.02) { changes.push({ param: 'wt', label: P.label, avant: prevParams.wt, apres: target, n: tk.length }); params.wt = target; }
    const mm = tk.reduce((s: number, t: any) => s + (t.buts - t.xgm) ** 2, 0) / tk.length, mk2 = tk.reduce((s: number, t: any) => s + (t.buts - t.xgk) ** 2, 0) / tk.length;
    lessons.push(`Buts attendus (${tk.length} équipes) : erreur moyenne de mon modèle ${Math.sqrt(mm).toFixed(2)} but, du marché ${Math.sqrt(mk2).toFixed(2)}. Poids du marché : ${Math.round(params.wt * 100)} %.`);
  }
  // 2d. Poids du modèle « sur la glace » pour les points joueurs
  const pi = graded.filter(p => p.type === 'Point joueur' && p.lam_old > 0 && p.lam_ipp > 0).slice(-1500);
  if (pi.length >= 150) {
    const P = PRIORS.wi;
    const nllI = (w: number) => pi.reduce((s, p) => s + ll(pNB(((1 - w) * p.lam_old + w * p.lam_ipp) * params.ap, params.rp), p.resultat), 0);
    let bw = P.v, bv = Infinity;
    for (let w = 0; w <= 1.0001; w += 0.05) { const v = nllI(w) + (w - P.v) ** 2 / (2 * P.sd ** 2); if (v < bv) { bv = v; bw = w; } }
    const gain = nllI(P.v) - nllI(bw);
    const target = r3(gain >= LR[1] ? bw : P.v, 2)!;
    if (Math.abs(target - prevParams.wi) >= 0.02) { changes.push({ param: 'wi', label: P.label, avant: prevParams.wi, apres: target, n: pi.length }); params.wi = target; }
  }

  // 2b. Buts attendus des équipes contre buts réellement marqués (après-match)"""),
])
s = open(B + 'learn.mts', encoding='utf-8').read()
s = s.replace("  if (['home', 'b2b', 'inj', 'h2h', 'form', 'vthr'].includes(k)) return `${(v * 100).toFixed(1)} %`;\n  if (k === 'wm') return `${Math.round(v * 100)} %`;",
              "  if (['home', 'b2b', 'inj', 'h2h', 'form', 'vthr'].includes(k)) return `${(v * 100).toFixed(1)} %`;\n  if (['wm', 'wt', 'wi'].includes(k)) return `${Math.round(v * 100)} %`;")
open(B + 'learn.mts', 'w', encoding='utf-8').write(s)

P = 'public/index.html'
s = open(P, encoding='utf-8').read()
s = s.replace("k==='wm' ? Math.round(v*100)+' %'", "['wm','wt','wi'].includes(k) ? Math.round(v*100)+' %'")
open(P, 'w', encoding='utf-8').write(s)
print('ok')
