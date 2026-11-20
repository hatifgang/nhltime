import re
B = 'netlify/functions/lib/'


def patch(path, pairs):
    s = open(B + path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (path, old[:80])
        s = s.replace(old, new, 1)
    open(B + path, 'w', encoding='utf-8').write(s)


# ------------------------------------------------------------------ model.mts
patch('model.mts', [
    ("  vthr: number;   // seuil d'écart (points de probabilité) pour signaler une « valeur potentielle »\n}",
     "  vthr: number;   // seuil d'écart (points de probabilité) pour signaler une « valeur potentielle »\n"
     "  rg: number; ra: number; rp: number; // dispersion (paquets) des buts, passes, points : grand = loi de Poisson\n"
     "  xg: number;     // échelle des buts attendus des équipes, apprise sur les scores réels\n}"),
    ("  vthr: { v: 0.05, sd: 0, min: 0.04, max: 0.12, label: 'Seuil de valeur potentielle' },",
     "  vthr: { v: 0.05, sd: 0, min: 0.04, max: 0.12, label: 'Seuil de valeur potentielle' },\n"
     "  rg: { v: 12, sd: 0.6, min: 1.5, max: 60, label: 'Dispersion des buts joueurs' },\n"
     "  ra: { v: 8, sd: 0.6, min: 1.5, max: 60, label: 'Dispersion des passes joueurs' },\n"
     "  rp: { v: 5, sd: 0.6, min: 1.5, max: 60, label: 'Dispersion des points joueurs' },\n"
     "  xg: { v: 1, sd: 0.08, min: 0.8, max: 1.2, label: 'Échelle des buts attendus (équipes)' },"),
    ("  let lh = f.lg * (f.gfh / f.lg) * (f.gaa / f.lg) * (1 + p.home);\n  let la = f.lg * (f.gfa / f.lg) * (f.gah / f.lg) * (1 - p.home);",
     "  let lh = f.lg * (f.gfh / f.lg) * (f.gaa / f.lg) * (1 + p.home) * (p.xg ?? 1);\n  let la = f.lg * (f.gfa / f.lg) * (f.gah / f.lg) * (1 - p.home) * (p.xg ?? 1);"),
    ("export const pAtLeastOne = (lam: number) => 1 - Math.exp(-Math.max(0, lam));",
     "export const pAtLeastOne = (lam: number) => 1 - Math.exp(-Math.max(0, lam));\n"
     "/** P(au moins 1) avec dispersion (binomiale négative) : les points d'un joueur arrivent par paquets,\n"
     " * ce qui rend « au moins 1 » moins probable que ne le dit Poisson, surtout pour les gros producteurs. */\n"
     "export const pNB = (lam: number, r: number) => r >= 200 ? pAtLeastOne(lam) : 1 - (r / (r + Math.max(0, lam))) ** r;"),
])

# ------------------------------------------------------------------ learn.mts
patch('learn.mts', [
    ("import { gameProbs, PRIORS, pAtLeastOne, type Params, type GameFeat } from './model.mts';",
     "import { gameProbs, PRIORS, pNB, type Params, type GameFeat } from './model.mts';"),
    ("""function fitScale(rows: { lam: number; y: number }[], key: 'ag' | 'aa' | 'ap') {
  const pr = PRIORS[key];
  const obj = (a: number) => rows.reduce((s, r) => s + ll(pAtLeastOne(r.lam * a), r.y), 0) + (a - pr.v) ** 2 / (2 * pr.sd ** 2);
  let lo = pr.min, hi = pr.max;
  for (let i = 0; i < 40; i++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (obj(m1) < obj(m2)) hi = m2; else lo = m1; }
  return (lo + hi) / 2;
}""",
     """/** Échelle (a) et dispersion (r) d'un type de pari joueur, par maximum a posteriori sur une grille. */
function fitPlayer(rows: { lam: number; y: number }[], aKey: 'ag' | 'aa' | 'ap', rKey: 'rg' | 'ra' | 'rp') {
  const A = PRIORS[aKey], R = PRIORS[rKey];
  let best = { a: A.v, r: R.v, v: Infinity };
  for (let a = A.min; a <= A.max + 1e-9; a += 0.01) {
    for (let k = 0; k <= 30; k++) {
      const r = R.min * (R.max / R.min) ** (k / 30);
      let v = (a - A.v) ** 2 / (2 * A.sd ** 2) + (Math.log(r) - Math.log(R.v)) ** 2 / (2 * R.sd ** 2);
      for (const x of rows) v += ll(pNB(x.lam * a, r), x.y);
      if (v < best.v) best = { a, r, v };
    }
  }
  return best;
}
/** Échelle des buts attendus des équipes (loi de Poisson) sur les scores réels. */
function fitXg(rows: { xg: number; y: number }[]) {
  const P = PRIORS.xg;
  const obj = (s: number) => rows.reduce((t, r) => t + s * r.xg - r.y * Math.log(s * r.xg), 0) + (s - P.v) ** 2 / (2 * P.sd ** 2);
  let lo = P.min, hi = P.max;
  for (let i = 0; i < 40; i++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (obj(m1) < obj(m2)) hi = m2; else lo = m1; }
  return (lo + hi) / 2;
}"""),
    ("""  for (const [typ, key] of [['But joueur', 'ag'], ['Passe joueur', 'aa'], ['Point joueur', 'ap']] as const) {
    const pr = graded.filter(p => p.type === typ && p.lam_base);
    if (pr.length >= MIN_PLAYER) {
      const a = r3(fitScale(pr.map(p => ({ lam: p.lam_base, y: p.resultat })), key), 3)!;
      if (Math.abs(a - prevParams[key]) >= 0.005) { changes.push({ param: key, label: PRIORS[key].label, avant: r3(prevParams[key]), apres: a }); params[key] = a; }
    }
  }""",
     """  for (const [typ, key, rk] of [['But joueur', 'ag', 'rg'], ['Passe joueur', 'aa', 'ra'], ['Point joueur', 'ap', 'rp']] as const) {
    const pr = graded.filter(p => p.type === typ && p.lam_base);
    if (pr.length >= MIN_PLAYER) {
      const fit = fitPlayer(pr.map(p => ({ lam: p.lam_base, y: p.resultat })), key, rk);
      const a = r3(fit.a, 3)!, r = r3(fit.r, 2)!;
      if (Math.abs(a - prevParams[key]) >= 0.005) { changes.push({ param: key, label: PRIORS[key].label, avant: r3(prevParams[key]), apres: a, n: pr.length }); params[key] = a; }
      if (Math.abs(r - prevParams[rk]) / prevParams[rk] >= 0.05) { changes.push({ param: rk, label: PRIORS[rk].label, avant: r3(prevParams[rk], 2), apres: r, n: pr.length }); params[rk] = r; }
    }
  }
  // 2b. Buts attendus des équipes contre buts réellement marqués (après-match)
  const tm = (db.postmatch?.teams || []).filter((t: any) => t.xg > 0);
  if (tm.length >= 40) {
    const s = r3(fitXg(tm.map((t: any) => ({ xg: t.xg / (t.xg_scale || 1), y: t.buts }))), 3)!;
    if (Math.abs(s - prevParams.xg) >= 0.005) { changes.push({ param: 'xg', label: PRIORS.xg.label, avant: r3(prevParams.xg), apres: s, n: tm.length }); params.xg = s; }
  }
  // 2c. Lecture des après-matchs : pourquoi les paris joueurs probables ont échoué
  const pm = (db.postmatch?.players || []).filter((x: any) => x.res === 0 && x.prob >= 0.5 && x.type === 'Point joueur');
  if (pm.length >= 20) {
    const by: Record<string, number> = {};
    for (const x of pm) by[x.cause] = (by[x.cause] || 0) + 1;
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]);
    const [c1, n1] = top[0];
    lessons.push(`Sur ${pm.length} points manqués à 50 % ou plus : ${top.map(([c, n]) => `${c} ${Math.round(100 * n / pm.length)} %`).join(', ')}.`);
    if (c1 === 'Équipe muselée' && n1 / pm.length >= 0.4) lessons.push(`La première cause d'échec est le match de l'équipe, pas le joueur : je limite déjà à 2 joueurs par équipe dans la sélection, et je le garde.`);
    if ((by['Temps de glace réduit'] || 0) / pm.length >= 0.2) lessons.push(`Beaucoup d'échecs viennent d'un temps de glace plus faible que prévu : le temps de glace récent pèse désormais dans le calcul.`);
  }
  const tmRecent = tm.slice(-60);
  if (tmRecent.length >= 30) {
    const diff = tmRecent.reduce((s: number, t: any) => s + (t.buts - t.xg), 0) / tmRecent.length;
    const se = Math.sqrt(tmRecent.reduce((s: number, t: any) => s + t.xg, 0)) / tmRecent.length;
    if (Math.abs(diff) > 1.96 * se) lessons.push(`Sur les ${tmRecent.length} dernières équipes, ${diff < 0 ? 'je surestime' : 'je sous-estime'} les buts marqués de ${Math.abs(diff).toFixed(2)} par match : l'échelle des buts attendus s'ajuste.`);
  }"""),
    ("  if (c.param === 'wm') return `${c.label} : ${arrow}. Calculé sur les matchs où une cote nhl.com était disponible.`;",
     "  if (c.param === 'wm') return `${c.label} : ${arrow}. Calculé sur les matchs où une cote nhl.com était disponible.`;\n"
     "  if (['rg', 'ra', 'rp'].includes(c.param)) return `${c.label} : ${arrow} (${c.n} paris évalués). Plus la valeur est basse, plus les points arrivent par paquets et plus « au moins 1 » est difficile pour les gros producteurs.`;\n"
     "  if (['ag', 'aa', 'ap'].includes(c.param)) return `${c.label} : ${arrow} (${c.n} paris évalués, comparaison probabilités / résultats réels).`;\n"
     "  if (c.param === 'xg') return `${c.label} : ${arrow} (${c.n} scores d'équipe comparés aux buts attendus).`;"),
])
s = open(B + 'learn.mts', encoding='utf-8').read()
s = s.replace("const arrow = `${fmt(c.param, c.avant)} → ${fmt(c.param, c.apres)}`;\n  if (c.param === 'home')", "const arrow = `${fmt(c.param, c.avant)} → ${fmt(c.param, c.apres)}`;\n  const k = c.param;\n  if (c.param === 'home')")
open(B + 'learn.mts', 'w', encoding='utf-8').write(s)

# ------------------------------------------------------------------ pipeline.mts
patch('pipeline.mts', [
    ("import { gameProbs, defaultParams, pAtLeastOne, PRIORS, type Params, type GameFeat } from './model.mts';",
     "import { gameProbs, defaultParams, pNB, PRIORS, type Params, type GameFeat } from './model.mts';"),
    ("    const { results, newlyGraded } = await gradeAndResults(ctx, db, yday);",
     "    const { results, newlyGraded } = await gradeAndResults(ctx, db, yday, params);"),
    ("async function gradeAndResults(ctx: Ctx, db: any, yday: string) {",
     "async function gradeAndResults(ctx: Ctx, db: any, yday: string, params: Params) {"),
    ("""      p.resultat = !st ? 'N/J' : (/but/i.test(p.type) ? +(st.goals > 0) : /passe/i.test(p.type) ? +(st.assists > 0) : +(st.points > 0));
    }
    newly++;
  }""",
     """      p.resultat = !st ? 'N/J' : (/but/i.test(p.type) ? +(st.goals > 0) : /passe/i.test(p.type) ? +(st.assists > 0) : +(st.points > 0));
    }
    newly++;
    postMatch(db, p, box, params);
  }"""),
    # prédictions : on garde ce qu'il faut pour l'après-match
    ("      gardiens_ok: !!(game.gardiens[game.exterieur].stats && game.gardiens[game.domicile].stats) });",
     "      gardiens_ok: !!(game.gardiens[game.exterieur].stats && game.gardiens[game.domicile].stats), xg_dom: game.buts_attendus_dom, xg_ext: game.buts_attendus_ext, xg_scale: params.xg });"),
    ("prob: pl[pk], lam_base: r3(pl[lk], 4), cote: null, prob_implicite: null, valeur: null });",
     "prob: pl[pk], lam_base: r3(pl[lk], 4), cote: null, prob_implicite: null, valeur: null, equipe: pl.equipe, s_exp: pl.s_rate, toi_exp: Math.round(pl.toi_eff || pl.toi_sec || 0), xg_team: pl.xg_team });"),
    ("""          lam_but: p.g_rate * teamF * 0.95, lam_passe: p.a_rate * teamF * 0.88, lam_point: p.p_rate * teamF * 0.82,
          p_but: r3(pAtLeastOne(p.g_rate * teamF * 0.95 * params.ag)), p_passe: r3(pAtLeastOne(p.a_rate * teamF * 0.88 * params.aa)), p_point: r3(pAtLeastOne(p.p_rate * teamF * 0.82 * params.ap)),""",
     """          // Dispersion apprise sur les résultats réels : les points arrivent par paquets (soirs à 3 points, soirs à 0).
          lam_but: p.g_rate * teamF, lam_passe: p.a_rate * teamF, lam_point: p.p_rate * teamF, xg_team: r3(lamT, 2),
          p_but: r3(pNB(p.g_rate * teamF * params.ag, params.rg)), p_passe: r3(pNB(p.a_rate * teamF * params.aa, params.ra)), p_point: r3(pNB(p.p_rate * teamF * params.ap, params.rp)),"""),
    # temps de glace récent
    ("""    else pr.lecture = `Production cohérente avec son volume de tirs (${g10} buts pour ${xg10.toFixed(1)} attendus sur ${n} matchs).`;
  }""",
     """    else pr.lecture = `Production cohérente avec son volume de tirs (${g10} buts pour ${xg10.toFixed(1)} attendus sur ${n} matchs).`;
  }
  // Temps de glace des 5 derniers matchs : une promotion ou une rétrogradation change vraiment ses chances.
  const toiSec = (t: string) => { const [m, s] = String(t || '0:0').split(':').map(Number); return (m || 0) * 60 + (s || 0); };
  const l5 = logs.slice(0, 5).filter((x: any) => x.toi);
  if (l5.length >= 3 && pr.toi_sec > 0) {
    const t5 = l5.reduce((s: number, x: any) => s + toiSec(x.toi), 0) / l5.length;
    const f = clamp(Math.sqrt(t5 / pr.toi_sec), 0.85, 1.12);
    pr.g_rate *= f; pr.a_rate *= f; pr.p_rate *= f; pr.toi_eff = t5;
    pr.toi_recent = fmtSec(t5);
    if (Math.abs(f - 1) >= 0.04) pr.lecture = (pr.lecture ? pr.lecture + ' ' : '') + `Temps de glace récent ${f > 1 ? 'en hausse' : 'en baisse'} (${fmtSec(t5)} sur 5 matchs contre ${fmtSec(pr.toi_sec)} en moyenne) : ses chances sont ${f > 1 ? 'relevées' : 'réduites'} en conséquence.`;
  }"""),
    # après-match + entretien
    ("function prune(db: any, today: string) {",
     """// ------------------------------------------------------------------ après-match : pourquoi ça a marché ou raté
function postMatch(db: any, p: any, box: any, params: Params) {
  db.postmatch = db.postmatch || { teams: [], players: [] };
  const a = box.awayTeam, h = box.homeTeam;
  const score: Record<string, number> = { [a.abbrev]: a.score, [h.abbrev]: h.score };
  const shots: Record<string, number> = { [a.abbrev]: a.sog, [h.abbrev]: h.sog };
  if (p.type === 'Vainqueur') {
    let xd = p.xg_dom, xe = p.xg_ext, sc = p.xg_scale || 1;
    if ((xd == null || xe == null) && p.feat) { const g = gameProbs(p.feat, params); xd = r3(g.lh, 2); xe = r3(g.la, 2); sc = params.xg; }
    if (xd == null) return;
    const svOf = (side: 'awayTeam' | 'homeTeam') => { const gk = (box.playerByGameStats?.[side]?.goalies || []).find((x: any) => x.starter) || (box.playerByGameStats?.[side]?.goalies || [])[0]; return gk?.savePctg ?? null; };
    db.postmatch.teams = db.postmatch.teams.filter((t: any) => t.game_id !== p.game_id).concat([
      { date: p.date, game_id: p.game_id, equipe: h.abbrev, adversaire: a.abbrev, xg: xd, xg_scale: sc, buts: h.score, tirs: h.sog, sv_adv: svOf('awayTeam') },
      { date: p.date, game_id: p.game_id, equipe: a.abbrev, adversaire: h.abbrev, xg: xe, xg_scale: sc, buts: a.score, tirs: a.sog, sv_adv: svOf('homeTeam') },
    ]);
    return;
  }
  if (p.type !== 'Point joueur' && p.type !== 'But joueur') return;
  const st = boxPlayers(box).get(p.player_id);
  const toi = st?.toi ? (() => { const [m, s] = st.toi.split(':').map(Number); return m * 60 + s; })() : 0;
  const team = st?.team || p.equipe, tg = score[team];
  if (p.xg_team == null) {  // anciennes prédictions : buts attendus de l'équipe retrouvés via le pronostic du match
    const w = db.predictions.find((x: any) => x.game_id === p.game_id && x.type === 'Vainqueur');
    if (w) { let xd = w.xg_dom, xe = w.xg_ext; if ((xd == null || xe == null) && w.feat) { const g = gameProbs(w.feat, params); xd = g.lh; xe = g.la; } if (xd != null) p.xg_team = r3(team === h.abbrev ? xd : xe, 2); }
  }
  let cause = 'Réussi';
  if (p.resultat === 'N/J') cause = 'N’a pas joué';
  else if (p.resultat === 0) {
    if (tg != null && (tg <= 1 || (p.xg_team && tg <= p.xg_team - 1.5))) cause = 'Équipe muselée';
    else if (p.toi_exp && toi < 0.8 * p.toi_exp) cause = 'Temps de glace réduit';
    else if (p.type === 'But joueur' && p.s_exp && (st?.sog ?? 0) <= 0.5 * p.s_exp) cause = 'Peu de tirs';
    else if (p.type === 'But joueur') cause = 'Tirs sans réussite';
    else if (p.xg_team && tg >= p.xg_team) cause = 'Pas impliqué sur les buts';
    else cause = 'Variance normale';
  }
  db.postmatch.players = db.postmatch.players.filter((x: any) => !(x.game_id === p.game_id && x.player_id === p.player_id && x.type === p.type)).concat([{
    date: p.date, game_id: p.game_id, player_id: p.player_id, nom: p.selection, equipe: team, type: p.type, prob: p.prob, res: p.resultat,
    toi: toi || null, toi_exp: p.toi_exp || null, tirs: st?.sog ?? null, tirs_exp: p.s_exp ?? null, buts_equipe: tg ?? null, xg_equipe: p.xg_team ?? null, tirs_equipe: shots[team] ?? null, cause,
  }]);
}

export function apresMatch(db: any, day: string) {
  const pm = db.postmatch || { teams: [], players: [] };
  const teams = pm.teams.filter((t: any) => t.date === day);
  const players = pm.players.filter((x: any) => x.date === day && x.type === 'Point joueur');
  const since = addDays(day, -30);
  const recent = pm.players.filter((x: any) => x.date >= since && x.type === 'Point joueur' && x.res === 0 && x.prob >= 0.5);
  const causes: Record<string, number> = {};
  for (const x of recent) causes[x.cause] = (causes[x.cause] || 0) + 1;
  const hi = players.filter((x: any) => x.prob >= 0.6 && x.res !== 'N/J');
  return { date: day, equipes: teams, joueurs: players, hauts: { n: hi.length, reussis: hi.filter((x: any) => x.res === 1).length },
    causes_30j: Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([cause, n]) => ({ cause, n, part: r3(n / Math.max(1, recent.length)) })), n_30j: recent.length };
}

function prune(db: any, today: string) {
  if (db.postmatch) {
    db.postmatch.teams = db.postmatch.teams.filter((x: any) => daysBetween(x.date, today) <= 180);
    db.postmatch.players = db.postmatch.players.filter((x: any) => daysBetween(x.date, today) <= 120);
  }"""),
    ("      learning: { params, priors: PRIORS, journal: db.journal.slice(-30).reverse() },",
     "      learning: { params, priors: PRIORS, journal: db.journal.slice(-30).reverse() },\n      apres: apresMatch(db, yday),"),
])

# rétro-analyse : les prédictions déjà évaluées alimentent l'après-match une fois
s = open(B + 'pipeline.mts', encoding='utf-8').read()
s = s.replace("""    // 2. Apprentissage (seulement si de nouvelles prédictions ont été évaluées)""",
"""    // 1b. Rétro-analyse des soirées déjà évaluées avant l'existence de l'après-match
    if (!db.postmatch) await backfillPostMatch(db, params);

    // 2. Apprentissage (seulement si de nouvelles prédictions ont été évaluées)""", 1)
s = s.replace("export function apresMatch(db: any, day: string) {", """async function backfillPostMatch(db: any, params: Params) {
  db.postmatch = { teams: [], players: [] };
  const done = db.predictions.filter((p: any) => p.resultat != null && p.game_id && ['Vainqueur', 'Point joueur', 'But joueur'].includes(p.type));
  const ids = [...new Set<number>(done.map((p: any) => p.game_id))];
  const boxes = new Map<number, any>((await pool(ids, 16, async id => [id, await safe(`${W}/gamecenter/${id}/boxscore`, null)] as const)).filter(([, b]) => b));
  for (const p of done) { const b = boxes.get(p.game_id); if (b) postMatch(db, p, b, params); }
}

export function apresMatch(db: any, day: string) {""", 1)
open(B + 'pipeline.mts', 'w', encoding='utf-8').write(s)
print('ok')
