// Apprentissage quotidien : on compare chaque prédiction au résultat réel, on réajuste les
// paramètres du modèle par maximum a posteriori (log-loss + rappel vers les valeurs de départ,
// pour ne pas sur-réagir au hasard), et on écrit un journal critique en français.
import { gameProbs, PRIORS, pNB, pAtLeastK, pmfNB, BTTS_DEFAULT, type Params, type GameFeat } from './model.mts';
import { r3, clamp, logit, sigmoid } from './util.mts';

const TEAM_KEYS: (keyof Params)[] = ['form', 'b2b', 'goalie', 'inj', 'h2h', 'bG', 'bS', 'bC', 'bX', 'rr'];   // bG..rr : poids de la force des équipes, appris seulement sur les matchs qui ont ces composantes   // home, wm, wt, xg : estimés seuls (a posteriori)
const MIN_GAMES = 25;      // en dessous : pas d'ajustement des paramètres d'équipe
const MIN_PLAYER = 150;    // idem pour les échelles joueurs
const ll = (p: number, y: number) => -(y * Math.log(Math.max(1e-6, p)) + (1 - y) * Math.log(Math.max(1e-6, 1 - p)));

interface GameRow { f: GameFeat; y: number }

function teamObjective(rows: GameRow[], p: Params) {
  let s = 0;
  for (const r of rows) s += ll(gameProbs(r.f, p).final_h, r.y);
  for (const k of TEAM_KEYS) { const pr = PRIORS[k]; s += (p[k] - pr.v) ** 2 / (2 * pr.sd ** 2); }
  return s;
}

/** Descente de coordonnées bornée, pas décroissant : robuste et suffisant pour 7 paramètres. */
function fitTeam(rows: GameRow[], start: Params): Params {
  const p = { ...start };
  for (const k of TEAM_KEYS) p[k] = PRIORS[k].v;   // on repart toujours des valeurs de départ : MAP sur tout l'historique
  const hasMkt = rows.some(r => r.f.mkt_h != null);
  let best = teamObjective(rows, p);
  for (let round = 0; round < 6; round++) {
    for (const k of TEAM_KEYS) {
      if (k === 'wm' && !hasMkt) continue;
      let step = (PRIORS[k].max - PRIORS[k].min) / 8 / (round + 1);
      for (let it = 0; it < 12 && step > 1e-4; it++) {
        let moved = false;
        for (const dir of [1, -1]) {
          const trial = { ...p, [k]: clamp(p[k] + dir * step, PRIORS[k].min, PRIORS[k].max) };
          const v = teamObjective(rows, trial);
          if (v < best - 1e-9) { best = v; Object.assign(p, trial); moved = true; break; }
        }
        if (!moved) step /= 2;
      }
    }
  }
  return p;
}

/** Échelle (a) et dispersion (r) d'un type de pari joueur, par maximum a posteriori sur une grille. */
function fitPlayer(rows: { lam: number; y: number }[], aKey: 'ag' | 'aa' | 'ap', rKey: 'rg' | 'ra' | 'rp') {
  const A = PRIORS[aKey], R = PRIORS[rKey];
  let best = { a: A.v, r: R.v, v: Infinity };
  for (let a = A.min; a <= A.max + 1e-9; a += 0.02) {
    for (let k = 0; k <= 20; k++) {
      const r = R.min * (R.max / R.min) ** (k / 20);
      let v = (a - A.v) ** 2 / (2 * A.sd ** 2) + (Math.log(r) - Math.log(R.v)) ** 2 / (2 * R.sd ** 2);
      for (const x of rows) v += ll(pNB(x.lam * a, r), x.y);
      if (v < best.v) best = { a, r, v };
    }
  }
  const dataNll = (a: number, r: number) => rows.reduce((s, x) => s + ll(pNB(x.lam * a, r), x.y), 0);
  return { ...best, gain: dataNll(A.v, R.v) - dataNll(best.a, best.r) };
}
/** Échelle des buts attendus des équipes (loi de Poisson) sur les scores réels. */
function fitXg(rows: { xg: number; y: number }[]) {
  const P = PRIORS.xg;
  const obj = (s: number) => rows.reduce((t, r) => t + s * r.xg - r.y * Math.log(s * r.xg), 0) + (s - P.v) ** 2 / (2 * P.sd ** 2);
  let lo = P.min, hi = P.max;
  for (let i = 0; i < 40; i++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (obj(m1) < obj(m2)) hi = m2; else lo = m1; }
  const s = (lo + hi) / 2;
  const nll = (k: number) => rows.reduce((t, r) => t + k * r.xg - r.y * Math.log(k * r.xg), 0);
  return { s, gain: nll(P.v) - nll(s) };
}

// Garde-fou : un réglage ne quitte sa valeur de départ que si les résultats le prouvent
// (test du rapport de vraisemblance, seuil 5 % : 1,92 pour 1 réglage, 3,0 pour 2, 7,0 pour 7).
const LR = { 1: 1.92, 2: 3.0, 5: 5.5, 6: 6.3, 7: 7.0 } as const;

function segment(rows: { p: number; y: number }[]) {
  const n = rows.length;
  if (!n) return null;
  const pred = rows.reduce((s, r) => s + r.p, 0) / n, real = rows.reduce((s, r) => s + r.y, 0) / n;
  const se = Math.sqrt(rows.reduce((s, r) => s + r.p * (1 - r.p), 0)) / n;
  return { n, prevu: r3(pred), reel: r3(real), ecart: r3(real - pred), ic95: r3(1.96 * se), significatif: n >= 30 && Math.abs(real - pred) > 1.96 * se };
}
const pctS = (x: number) => `${Math.round(x * 100)} %`;

export function learn(db: any, prevParams: Params, today: string) {
  const preds = db.predictions as any[];
  const graded = preds.filter(p => p.resultat === 0 || p.resultat === 1);
  const winners = graded.filter(p => p.type === 'Vainqueur' && p.feat);
  const rows: GameRow[] = winners.map(p => ({ f: p.feat, y: p.selection_abbr === p.domicile ? p.resultat : 1 - p.resultat }));
  const params: Params = { ...prevParams };
  const changes: any[] = [];
  const lessons: string[] = [];

  // 1. Paramètres d'équipe
  if (rows.length >= MIN_GAMES) {
    const fitted = fitTeam(rows, prevParams);
    const base: Params = { ...prevParams }; for (const k of TEAM_KEYS) base[k] = PRIORS[k].v;
    const nll = (p: Params) => rows.reduce((s, r) => s + ll(gameProbs(r.f, p).final_h, r.y), 0);
    const gain = nll(base) - nll(fitted);
    const proven = gain >= LR[5];
    if (!proven) lessons.push(`Forme, fatigue, gardien, absences, confrontations, poids buts/tirs/Corsi/xG : les ${rows.length} matchs évalués ne prouvent pas encore qu'il faut changer (gain ${gain.toFixed(2)} < ${LR[5]}). Je garde les réglages de départ.`);
    for (const k of TEAM_KEYS) {
      const before = prevParams[k], after = r3(proven ? fitted[k] : PRIORS[k].v, 3)!;
      if (Math.abs(after - before) >= 0.002) { changes.push({ param: k, label: PRIORS[k].label, avant: r3(before), apres: after }); params[k] = after; }
    }
  }
  // 2. Échelles joueurs
  for (const [typ, key, rk] of [['But joueur', 'ag', 'rg'], ['Passe joueur', 'aa', 'ra'], ['Point joueur', 'ap', 'rp']] as const) {
    const all = graded.filter(p => p.type === typ && p.lam_base), v2 = all.filter(p => (p.v ?? 1) >= 2);
    const pr = v2.length >= MIN_PLAYER ? v2 : all;   // dès que le moteur actuel a assez de résultats, on n'apprend que sur lui
    if (pr.length >= MIN_PLAYER) {
      const fit = fitPlayer(pr.slice(-1500).map(p => ({ lam: p.lam_base, y: p.resultat })), key, rk);   // les 1 500 plus récents : assez pour juger, rapide
      const proven = fit.gain >= LR[2];
      const a = r3(proven ? fit.a : PRIORS[key].v, 3)!, r = r3(proven ? fit.r : PRIORS[rk].v, 2)!;
      if (!proven) lessons.push(`${typ} : sur ${pr.length} paris évalués, l'écart entre prévu et réel reste dans le bruit (gain ${fit.gain.toFixed(2)} < ${LR[2]}). Calcul inchangé.`);
      if (Math.abs(a - prevParams[key]) >= 0.005) { changes.push({ param: key, label: PRIORS[key].label, avant: r3(prevParams[key]), apres: a, n: pr.length }); params[key] = a; }
      if (Math.abs(r - prevParams[rk]) / prevParams[rk] >= 0.05) { changes.push({ param: rk, label: PRIORS[rk].label, avant: r3(prevParams[rk], 2), apres: r, n: pr.length }); params[rk] = r; }
    }
  }
  // 1a. Avantage domicile, estimé seul (a posteriori)
  if (rows.length >= 30) {
    const H = PRIORS.home;
    const nllH = (x: number) => rows.reduce((s, r) => s + ll(gameProbs(r.f, { ...params, home: x }).final_h, r.y), 0) + (x - H.v) ** 2 / (2 * H.sd ** 2);
    let bh = H.v, bv = Infinity;
    for (let x = H.min; x <= H.max + 1e-9; x += 0.005) { const v = nllH(x); if (v < bv) { bv = v; bh = x; } }
    const target = r3(bh, 3)!;
    if (Math.abs(target - prevParams.home) >= 0.003) { changes.push({ param: 'home', label: H.label, avant: prevParams.home, apres: target, n: rows.length }); params.home = target; }
    const hw = rows.filter(r => r.y === 1).length / rows.length;
    lessons.push(`Domicile : les équipes à domicile ont gagné ${Math.round(hw * 100)} % des ${rows.length} matchs. Avantage retenu : ${(params.home * 100).toFixed(1)} %.`);
  }
  // 1c. Défenseurs : leurs buts, passes et points ne suivent pas la même échelle que les attaquants
  for (const [typ, key, base, r] of [['But joueur', 'gD', 'ag', 'rg'], ['Passe joueur', 'aD', 'aa', 'ra'], ['Point joueur', 'pD', 'ap', 'rp']] as const) {
    const dr = graded.filter(p => p.type === typ && p.pos === 'D' && p.lam_base > 0 && (p.v ?? 1) >= 2).slice(-1500);
    if (dr.length < 60) continue;
    const K = PRIORS[key];
    const nllD = (x: number) => dr.reduce((s, p) => s + ll(pNB(p.lam_base * params[base] * x, params[r]), p.resultat), 0) + (x - K.v) ** 2 / (2 * K.sd ** 2);
    let bx = K.v, bv = Infinity;
    for (let x = K.min; x <= K.max + 1e-9; x += 0.01) { const v = nllD(x); if (v < bv) { bv = v; bx = x; } }
    const target = r3(bx, 2)!;
    if (Math.abs(target - prevParams[key]) >= 0.02) { changes.push({ param: key, label: K.label, avant: prevParams[key], apres: target, n: dr.length }); params[key] = target; }
  }

  // 1b. Confiance face au marché : estimée seule (1 réglage), pour pouvoir admettre vite que les cotes font mieux.
  const mk = rows.filter(r => r.f.mkt_h != null);
  if (mk.length >= 30) {
    const W = PRIORS.wm;
    const nllW = (w: number) => mk.reduce((s, r) => s + ll(gameProbs(r.f, { ...params, wm: w }).final_h, r.y), 0);
    let bw = W.v, bv = Infinity;
    for (let w = W.min; w <= W.max + 1e-9; w += 0.02) { const v = nllW(w) + (w - W.v) ** 2 / (2 * W.sd ** 2); if (v < bv) { bv = v; bw = w; } }
    const gain = nllW(W.v) - nllW(bw);
    const target = r3(bw, 2)!;   // estimation a posteriori : bouge en proportion des preuves
    if (Math.abs(target - prevParams.wm) >= 0.02) { changes.push({ param: 'wm', label: W.label, avant: prevParams.wm, apres: target, n: mk.length }); params.wm = target; }
    lessons.push(`Modèle contre marché (${mk.length} matchs) : poids de mon modèle ${Math.round(params.wm * 100)} %, celui des cotes ${100 - Math.round(params.wm * 100)} % (estimation a posteriori, gain ${gain.toFixed(2)}).`);
  }

  // 2a. Tirs cadrés : vraisemblance complète du nombre de tirs (plus informative que « au moins 2 »)
  const shotRows = (Object.values(Object.fromEntries((db.postmatch?.players || []).filter((x: any) => x.tirs != null && x.tirs_exp > 0 && x.res !== 'N/J').map((x: any) => [`${x.date}-${x.player_id}`, x]))) as any[]).slice(-1500);
  if (shotRows.length >= 150) {
    const A = PRIORS.as, R = PRIORS.rs;
    const nllS = (a: number, r: number) => shotRows.reduce((s, x) => s - Math.log(Math.max(1e-9, pmfNB(x.tirs_exp * a, x.tirs, r))), 0);
    let best = { a: A.v, r: R.v, v: Infinity };
    for (let a = A.min; a <= A.max + 1e-9; a += 0.02) for (let k = 0; k <= 20; k++) {
      const r = R.min * (R.max / R.min) ** (k / 20);
      const v = nllS(a, r) + (a - A.v) ** 2 / (2 * A.sd ** 2) + (Math.log(r) - Math.log(R.v)) ** 2 / (2 * R.sd ** 2);
      if (v < best.v) best = { a, r, v };
    }
    const gain = nllS(A.v, R.v) - nllS(best.a, best.r);
    const a = r3(gain >= LR[2] ? best.a : A.v, 3)!, r = r3(gain >= LR[2] ? best.r : R.v, 2)!;
    if (Math.abs(a - prevParams.as) >= 0.005) { changes.push({ param: 'as', label: A.label, avant: prevParams.as, apres: a, n: shotRows.length }); params.as = a; }
    if (Math.abs(r - prevParams.rs) / prevParams.rs >= 0.05) { changes.push({ param: 'rs', label: R.label, avant: prevParams.rs, apres: r, n: shotRows.length }); params.rs = r; }
  }

  // 2c. Poids du marché dans les buts attendus : vraisemblance des buts réellement marqués
  const tk = (db.postmatch?.teams || []).filter((t: any) => t.xgm > 0 && t.xgk > 0);
  if (tk.length >= 40) {
    const P = PRIORS.wt;
    const nllT = (w: number) => tk.reduce((s: number, t: any) => { const lam = Math.exp((1 - w) * Math.log(t.xgm) + w * Math.log(t.xgk)) * (params.xg / (t.xg_scale || 1)); return s + lam - t.buts * Math.log(lam); }, 0);
    let bw = P.v, bv = Infinity;
    for (let w = 0; w <= 1.0001; w += 0.02) { const v = nllT(w) + (w - P.v) ** 2 / (2 * P.sd ** 2); if (v < bv) { bv = v; bw = w; } }
    const gain = nllT(P.v) - nllT(bw);
    const target = r3(bw, 2)!;
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
    const target = r3(bw, 2)!;
    if (Math.abs(target - prevParams.wi) >= 0.02) { changes.push({ param: 'wi', label: P.label, avant: prevParams.wi, apres: target, n: pi.length }); params.wi = target; }
  }

  // 2b. Buts attendus des équipes contre buts réellement marqués (après-match)
  const tm = (db.postmatch?.teams || []).filter((t: any) => t.xg > 0 && (t.v ?? 1) >= 2);   // seulement le moteur actuel
  if (tm.length >= 40) {
    const fx = fitXg(tm.map((t: any) => ({ xg: t.xg / (t.xg_scale || 1), y: t.buts })));
    const s = r3(fx.s, 3)!;
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
  }
  // 3. Seuil de valeur : prudence accrue si les « valeurs potentielles » perdent de l'argent
  const vals = graded.filter(p => p.valeur === 'Valeur potentielle' && p.cote);
  if (vals.length >= 40) {
    const roi = vals.reduce((s, p) => s + (p.resultat ? p.cote - 1 : -1), 0) / vals.length;
    let thr = prevParams.vthr;
    if (roi < 0) thr = Math.min(PRIORS.vthr.max, thr + 0.01);
    else if (roi > 0.03 && vals.length >= 80) thr = Math.max(PRIORS.vthr.min, thr - 0.01);
    thr = r3(thr)!;
    if (thr !== prevParams.vthr) {
      changes.push({ param: 'vthr', label: PRIORS.vthr.label, avant: prevParams.vthr, apres: thr });
      params.vthr = thr;
      lessons.push(roi < 0
        ? `Les paris signalés « valeur potentielle » ont un rendement de ${(roi * 100).toFixed(1)} % sur ${vals.length} paris (mise fixe). Je deviens plus exigeant : il faut maintenant ${Math.round(thr * 100)} points d'écart avec la cote.`
        : `Les « valeurs potentielles » sont rentables (${(roi * 100).toFixed(1)} % sur ${vals.length} paris) : seuil ramené à ${Math.round(thr * 100)} points.`);
    }
  }

  // 4. Diagnostics par situation (le « sens critique ») : seulement les écarts statistiquement solides
  const W = winners.map(p => ({ p: p.prob, y: p.resultat, x: p }));
  const segs: Record<string, any> = {
    'Favori à domicile': segment(W.filter(r => r.x.selection_abbr === r.x.domicile)),
    'Favori à l’extérieur': segment(W.filter(r => r.x.selection_abbr !== r.x.domicile)),
    'Favori en 2e match en 2 soirs': segment(W.filter(r => (r.x.selection_abbr === r.x.domicile ? r.x.feat.b2b_h : r.x.feat.b2b_a))),
    'Gardien partant non confirmé': segment(W.filter(r => r.x.gardiens_ok === false)),
    'Favori très net (≥ 65 %)': segment(W.filter(r => r.p >= 0.65)),
    'Confiance Faible': segment(W.filter(r => r.x.confiance === 'Faible')),
    'Confiance Moyenne': segment(W.filter(r => r.x.confiance === 'Moyenne')),
    'Confiance Élevée': segment(W.filter(r => r.x.confiance === 'Élevée')),
  };
  for (const typ of ['But joueur', 'Passe joueur', 'Point joueur']) {
    const P = graded.filter(p => p.type === typ).map(p => ({ p: p.prob, y: p.resultat, x: p }));
    segs[`${typ} (attaquants)`] = segment(P.filter(r => r.x.pos !== 'D'));
    segs[`${typ} (défenseurs)`] = segment(P.filter(r => r.x.pos === 'D'));
    segs[`${typ} (ligne connue)`] = segment(P.filter(r => /^L|^P/.test(r.x.ligne || '')));
  }
  for (const [name, s] of Object.entries(segs)) {
    if (s?.significatif) lessons.push(`${name} : réussite réelle ${pctS(s.reel)} contre ${pctS(s.prevu)} prévus (${s.n} paris). ${s.ecart < 0 ? 'Je surestime ce cas : prudence.' : 'Je sous-estime ce cas.'}`);
  }

  // 5. Fiabilité des sources : gardien projeté vs gardien réellement aligné
  let gkOk = 0, gkN = 0;
  for (const p of preds) if (p.type === 'Vainqueur' && p.gardiens_check) for (const v of Object.values(p.gardiens_check)) { if (v === true || v === false) { gkN++; if (v) gkOk++; } }

  // 6. Comparaison modèle / marché / hasard
  const withMkt = rows.filter(r => r.f.mkt_h != null);
  const metric = (rs: GameRow[], fn: (r: GameRow) => number) => rs.length ? r3(rs.reduce((s, r) => s + ll(fn(r), r.y), 0) / rs.length, 4) : null;
  const metrics = {
    n_matchs: rows.length,
    logloss_modele: metric(rows, r => gameProbs(r.f, params).final_h),
    logloss_hasard: rows.length ? 0.6931 : null,
    n_avec_cotes: withMkt.length,
    logloss_modele_seul: metric(withMkt, r => gameProbs(r.f, params).model_h),
    logloss_marche: metric(withMkt, r => r.f.mkt_h!),
    gardiens_prevus_corrects: gkN ? r3(gkOk / gkN) : null, n_gardiens: gkN,
  };
  if (metrics.logloss_marche != null && metrics.logloss_modele_seul != null && withMkt.length >= 30) {
    lessons.push(metrics.logloss_modele_seul > metrics.logloss_marche
      ? `Sur ${withMkt.length} matchs, les cotes du marché prédisent mieux que mon modèle seul (log-loss ${metrics.logloss_marche} contre ${metrics.logloss_modele_seul}) : je m'appuie davantage sur le marché (poids du modèle ${Math.round(params.wm * 100)} %).`
      : `Sur ${withMkt.length} matchs, mon modèle seul fait mieux que le marché (log-loss ${metrics.logloss_modele_seul} contre ${metrics.logloss_marche}).`);
  }
  if (gkN >= 20 && gkOk / gkN < 0.85) lessons.push(`Les gardiens projetés par nhl.com n'ont été les bons que ${pctS(gkOk / gkN)} du temps (${gkN} cas) : l'effet gardien reste prudent tant qu'il n'est pas confirmé.`);
  if (rows.length < MIN_GAMES) lessons.push(`Apprentissage des paramètres d'équipe en attente : ${rows.length}/${MIN_GAMES} matchs évalués avec toutes les données. D'ici là, les réglages de départ s'appliquent.`);

  for (const c of changes) c.explication = explain(c, winners, rows);
  // 7. Recalage final : pour chaque type, ce que disent les résultats réels à chaque niveau de confiance,
  // recalculé avec les réglages actuels (on ne corrige pas deux fois une erreur déjà apprise).
  const edges = [0, 0.35, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
  const table = (pairs: { p: number; y: number }[]) => edges.slice(0, -1).map((lo, i) => {
    const b = pairs.filter(x => x.p >= lo && x.p < edges[i + 1]);
    return { lo, hi: edges[i + 1], n: b.length, prevu: b.length ? r3(b.reduce((s, x) => s + x.p, 0) / b.length) : null, reel: b.length ? r3(b.reduce((s, x) => s + x.y, 0) / b.length) : null };
  }).filter(b => b.n);
  const lamRows = (typ: string, a: number, r: number) => { const all = graded.filter(p => p.type === typ && p.lam_base), v2 = all.filter(p => (p.v ?? 1) >= 2); return v2.length >= 150 ? v2 : all; };
  const lamRowsP = (typ: string, a: number, r: number) => lamRows(typ, a, r).map(p => ({ p: pNB(p.lam_base * a, r), y: p.resultat }));
  const calib: any = {
    point: table(lamRowsP('Point joueur', params.ap, params.rp)),
    but: table(lamRowsP('But joueur', params.ag, params.rg)),
    tirs2: table(shotRows.map(x => ({ p: pAtLeastK(x.tirs_exp * params.as, 2, params.rs), y: +(x.tirs >= 2) }))),
    tirs3: table(shotRows.map(x => ({ p: pAtLeastK(x.tirs_exp * params.as, 3, params.rs), y: +(x.tirs >= 3) }))),
  };
  (params as any).calib = calib;
  for (const [k, lab] of [['point', 'Points'], ['but', 'Buts'], ['tirs2', '2 tirs et plus'], ['tirs3', '3 tirs et plus']] as const) {
    for (const b of calib[k]) {
      const se = Math.sqrt(b.prevu * (1 - b.prevu) / b.n);
      if (b.n >= 20 && Math.abs(b.reel - b.prevu) > 1.96 * se) lessons.push(`${lab} annoncés entre ${Math.round(b.lo * 100)} et ${Math.round(Math.min(1, b.hi) * 100)} % : réussite réelle ${Math.round(b.reel * 100)} % (${b.n} cas). Je recale ces probabilités vers la réalité.`);
    }
  }

  // 8. « Les deux équipes marquent » : parts des buts par période et recalage, appris sur les vrais scores
  {
    const seen = new Set<number>();
    const bt = graded.filter((p: any) => p.type === 'Deux marquent' && Array.isArray(p.res_seg) && p.xg_dom != null).reverse().filter((p: any) => !seen.has(p.game_id) && seen.add(p.game_id)).slice(0, 1500);
    if (bt.length >= 40) {
      const D = BTTS_DEFAULT, prev = (params as any).btts || D;
      const goals = [1, 2, 3].map(k => bt.reduce((s: number, p: any) => s + p.buts_seg[k][0] + p.buts_seg[k][1], 0));
      const T = goals.reduce((s, x) => s + x, 0), W0 = 3000;   // la saison passée pèse comme 3000 buts
      const s = [1, ...[1, 2, 3].map(k => r3((goals[k - 1] + W0 * D.s[k]) / (T + W0), 3)!)];
      const P1 = (l: number) => 1 - Math.exp(-l);
      const a: number[] = [], b: number[] = [];
      for (const k of [0, 1, 2, 3]) {
        const xs = bt.map((p: any) => ({ x: logit(Math.min(0.99, Math.max(0.01, P1(p.xg_dom * s[k]) * P1(p.xg_ext * s[k])))), y: p.res_seg[k] }));
        let best = { a: D.a[k], b: D.b[k], v: Infinity };
        for (let ai = -1; ai <= 1.5; ai += 0.02) for (let bi = 0.3; bi <= 2; bi += 0.05) {
          let v = (ai - D.a[k]) ** 2 / (2 * 0.25 ** 2) + (bi - D.b[k]) ** 2 / (2 * 0.2 ** 2);
          for (const { x, y } of xs) { const q = sigmoid(ai + bi * x); v -= y ? Math.log(q) : Math.log(1 - q); }
          if (v < best.v) best = { a: ai, b: bi, v };
        }
        a.push(r3(best.a, 2)!); b.push(r3(best.b, 2)!);
      }
      (params as any).btts = { s, a, b, n: bt.length };
      const rate = (k: number) => Math.round(bt.reduce((t: number, p: any) => t + p.res_seg[k], 0) / bt.length * 100);
      lessons.push(`Les deux équipes marquent (${bt.length} matchs notés) : match entier ${rate(0)} %, 1re période ${rate(1)} %, 2e ${rate(2)} %, 3e ${rate(3)} %. Recalage mis à jour (base : ${JSON.stringify(prev.a)} → ${JSON.stringify(a)}).`);
    }
  }

  return { params, entry: { date: today, changes, lessons, metrics, segments: segs, calib } };
}

function explain(c: any, winners: any[], rows: GameRow[]) {
  const arrow = `${fmt(c.param, c.avant)} → ${fmt(c.param, c.apres)}`;
  const k = c.param;
  if (c.param === 'home') {
    const homeWins = rows.filter(r => r.y === 1).length / rows.length;
    const pred = rows.reduce((s, r) => s + gameProbs(r.f, { ...PRIORS_V(), home: c.avant }).final_h, 0) / rows.length;
    return `${c.label} : ${arrow}. Les équipes à domicile ont gagné ${pctS(homeWins)} des ${rows.length} matchs, pour ${pctS(pred)} prévus.`;
  }
  if (c.param === 'b2b') {
    const b = winners.filter(p => p.feat.b2b_h || p.feat.b2b_a);
    return `${c.label} : ${arrow} (${b.length} matchs avec une équipe en 2e soir consécutif).`;
  }
  if (c.param === 'wm') return `${c.label} : ${arrow}. Calculé sur les matchs où une cote nhl.com était disponible.`;
  if (['rg', 'ra', 'rp'].includes(c.param)) return `${c.label} : ${arrow} (${c.n} paris évalués). Plus la valeur est basse, plus les points arrivent par paquets et plus « au moins 1 » est difficile pour les gros producteurs.`;
  if (['ag', 'aa', 'ap'].includes(c.param)) return `${c.label} : ${arrow} (${c.n} paris évalués, comparaison probabilités / résultats réels).`;
  if (c.param === 'xg') return `${c.label} : ${arrow} (${c.n} scores d'équipe comparés aux buts attendus).`;
  return `${c.label} : ${arrow}, d'après ${c.param.startsWith('a') && c.param.length === 2 ? 'les paris joueurs évalués' : `${rows.length} matchs évalués`}.`;
}
const PRIORS_V = () => Object.fromEntries(Object.entries(PRIORS).map(([k, p]) => [k, p.v])) as any;
function fmt(k: string, v: number) {
  if (['home', 'b2b', 'inj', 'h2h', 'form', 'vthr'].includes(k)) return `${(v * 100).toFixed(1)} %`;
  if (['wm', 'wt', 'wi'].includes(k)) return `${Math.round(v * 100)} %`;
  return v.toFixed(2);
}
