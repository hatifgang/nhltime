// Modèle NBA : même logique que le site NHL (volume d'abord, efficacité ramenée vers la moyenne, marché mêlé au modèle,
// réglages appris chaque nuit sur les résultats réels).
import { clamp } from '../util.mts';
import type { PRow } from './espn.mts';

export interface NbaParams {
  home: number; b2b: number; alt: number; inj: number;   // avantage domicile (points d'écart), 2e soir de suite, altitude, poids des absences
  wm: number; wt: number;                                 // poids du marché sur l'écart et sur le total
  sm: number; st: number;                                 // écarts-types : écart final, total de points
  sh: number; sq: number;                                 // écarts-types : écart d'une mi-temps, d'un quart-temps
  qs: number[];                                           // part du total marquée dans chaque quart-temps
  bl: number;                                             // baisse de minutes des titulaires quand le match s'annonce déséquilibré
  tb: number;                                             // correction du total du modèle (points)
  vthr: number;                                           // écart minimal (points de probabilité) pour signaler une valeur
  lw?: number;                                            // part de la correction « chance au tir » appliquée (1 = réglage de départ), apprise chaque nuit
  sc: Record<string, number>;                             // échelle moyenne par statistique (biais appris)
  vc: Record<string, number>; vd: Record<string, number>; // variance = vc·μ + vd·μ² par statistique
  calib?: Record<string, any[]>;
}
export const STATS = ['pts', 'reb', 'ast', 'p3', 'pra'] as const;
export type Stat = typeof STATS[number];
export const STAT_LAB: Record<Stat, string> = { pts: 'points', reb: 'rebonds', ast: 'passes', p3: 'paniers à 3 points', pra: 'points + rebonds + passes' };
export const LADDER: Record<Stat, number[]> = { pts: [10, 15, 20, 25, 30, 35, 40], reb: [4, 6, 8, 10, 12, 14], ast: [2, 4, 6, 8, 10, 12], p3: [1, 2, 3, 4, 5], pra: [15, 20, 25, 30, 35, 40, 45, 50] };

// Valeurs de départ calées sur le rejeu jour par jour de la saison 2025-26 et du début 2026-27 (1 241 matchs, 26 133 lignes joueurs, ESPN).
export const NBA_DEFAULT: NbaParams = {
  home: 1.4, b2b: 1.6, alt: 0.8, inj: 0.35, wm: 0.75, wt: 0.8, sm: 13.5, st: 19, sh: 11.2, sq: 8.3, qs: [0.2545, 0.2508, 0.2541, 0.2406], bl: 0.006, tb: 2.3, vthr: 0.04,
  sc: { pts: 0.943, reb: 0.954, ast: 0.978, p3: 0.945, pra: 0.95 }, vc: { pts: 3.69, reb: 1.49, ast: 1.36, p3: 1.31, pra: 3.88 }, vd: { pts: 0.005, reb: 0.005, ast: 0.005, p3: 0.005, pra: 0.005 },
};
export const PRIOR_SD: Record<string, number> = { home: 1.2, b2b: 1.0, inj: 0.2, wm: 0.15, wt: 0.12, sm: 1.5, st: 2.0 };

// ---------------------------------------------------------------- utilitaires de loi
export const Phi = (x: number) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
/** P(X >= k) pour une statistique entière de moyenne mu (approximation normale avec correction de continuité ; binomiale négative pour les petits comptes). */
export function pAtLeast(stat: Stat, mu: number, k: number, P: NbaParams) {
  mu = Math.max(0.01, mu * (P.sc?.[stat] ?? 1));
  const v = Math.max(0.3, (P.vc?.[stat] ?? 1) * mu + (P.vd?.[stat] ?? 0.05) * mu * mu);
  if (stat === 'p3' || mu < 6) {   // binomiale négative de même moyenne et variance
    const r = mu * mu / Math.max(1e-6, v - mu);
    if (v <= mu * 1.0001) { let c = 0, t = Math.exp(-mu); for (let i = 0; i < k; i++) { c += t; t *= mu / (i + 1); } return clamp(1 - c, 0, 1); }
    const q = mu / (r + mu); let t = (r / (r + mu)) ** r, c = 0;
    for (let i = 0; i < k; i++) { c += t; t = t * (i + r) / (i + 1) * q; }
    return clamp(1 - c, 0, 1);
  }
  return clamp(1 - Phi((k - 0.5 - mu) / Math.sqrt(v)), 0, 1);
}
export function calibrate(table: any[] | undefined, p: number) {
  if (!table || p == null) return p;
  const b = table.find((x: any) => p >= x.lo && p < x.hi);
  if (!b || !b.n) return p;
  return clamp(p + (b.n / (b.n + 40)) * (b.reel - b.prevu), 0.01, 0.97);
}

// ---------------------------------------------------------------- équipes
export interface TeamRow { date: string; id: string; team: string; opp: string; home: number; pts: number; opp_pts: number; poss: number; min: number; qt: number[]; oqt: number[];
  p3a: number; p3m: number; ftm: number; fta: number; o3a: number; o3m: number; oftm: number; ofta: number }
export const poss = (t: any) => t.fga - t.oreb + t.tov + 0.44 * t.fta;
export function teamRows(boxes: any[]): TeamRow[] {
  const out: TeamRow[] = [];
  for (const b of boxes) {
    const E = b.equipes?.[b.ext], H = b.equipes?.[b.dom];
    if (!E || !H) continue;
    const p = (poss(E) + poss(H)) / 2, min = 48 + 5 * (b.prol || 0);
    const sh = (me: any, op: any) => ({ p3a: me.p3a, p3m: me.p3m, ftm: me.ftm, fta: me.fta, o3a: op.p3a, o3m: op.p3m, oftm: op.ftm, ofta: op.fta });
    out.push({ date: b.date, id: b.id, team: b.ext, opp: b.dom, home: 0, pts: b.score_ext, opp_pts: b.score_dom, poss: p, min, qt: b.qt_ext, oqt: b.qt_dom, ...sh(E, H) });
    out.push({ date: b.date, id: b.id, team: b.dom, opp: b.ext, home: 1, pts: b.score_dom, opp_pts: b.score_ext, poss: p, min, qt: b.qt_dom, oqt: b.qt_ext, ...sh(H, E) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
export interface TeamRating { team: string; n: number; ortg: number; drtg: number; pace: number; net: number; ppg: number; papg: number; o_raw: number; d_raw: number; pace_raw: number;
  chance?: { p3: number | null; op3: number | null; oft: number | null; o_pts: number; d_pts: number; net_pts: number; net_adj?: number } }
/** « PDO » du basket : la réussite à 3 points (surtout celle des ADVERSAIRES) et les lancers francs adverses
 * dépendent beaucoup de la chance. On remplace la réussite observée par une réussite ramenée vers la moyenne,
 * puis on recalcule les points pour 100 possessions (« net rating corrigé de la chance »).
 * K3 / KO3 / KFT = nombre de tentatives « fictives » à la moyenne de la ligue (plus c'est grand, plus c'est de la chance). */
export const LUCK: { w: number; wo?: number; wd?: number; K3: number; KO3: number; KFT: number } = { w: 1, wo: 0.5, wd: 0.5, K3: 750, KO3: 3000, KFT: 1e9 };   // calé sur 1 241 matchs rejoués (2025-26 + début 2026-27)
export function teamRatings(rows: TeamRow[], K = 10, luck = LUCK) {
  const lgPoss = rows.reduce((s, r) => s + r.poss, 0), lgPts = rows.reduce((s, r) => s + r.pts, 0), lgMin = rows.reduce((s, r) => s + r.min, 0);
  const L = lgPoss ? 100 * lgPts / lgPoss : 114, LP = lgMin ? 48 * lgPoss / lgMin : 99;
  const lA3 = rows.reduce((s, r) => s + (r.p3a || 0), 0), lFA = rows.reduce((s, r) => s + (r.fta || 0), 0);
  const lg3 = lA3 ? rows.reduce((s, r) => s + (r.p3m || 0), 0) / lA3 : 0, lgFT = lFA ? rows.reduce((s, r) => s + (r.ftm || 0), 0) / lFA : 0.78;
  const by: Record<string, TeamRow[]> = {};
  for (const r of rows) (by[r.team] ||= []).push(r);
  const out: Record<string, TeamRating> = {};
  for (const [t, rs] of Object.entries(by)) {
    const n = rs.length, P = rs.reduce((s, r) => s + r.poss, 0), M = rs.reduce((s, r) => s + r.min, 0);
    let o = 100 * rs.reduce((s, r) => s + r.pts, 0) / P, d = 100 * rs.reduce((s, r) => s + r.opp_pts, 0) / P;
    const pace = 48 * P / M, o0 = o, d0 = d;
    let chance: TeamRating['chance'];
    if (luck?.w && lg3 > 0) {
      const S = (k: keyof TeamRow) => rs.reduce((s, r) => s + ((r as any)[k] || 0), 0);
      const a3 = S('p3a'), m3 = S('p3m'), oa3 = S('o3a'), om3 = S('o3m'), ofa = S('ofta'), ofm = S('oftm');
      const e3 = (m3 + lg3 * luck.K3) / (a3 + luck.K3), eo3 = (om3 + lg3 * luck.KO3) / (oa3 + luck.KO3), eft = (ofm + lgFT * luck.KFT) / (ofa + luck.KFT);
      const dO = 3 * (m3 - a3 * e3), dD = 3 * (om3 - oa3 * eo3) + (ofm - ofa * eft);   // points « de chance » marqués / encaissés
      o -= luck.w * (luck.wo ?? 1) * 100 * dO / P; d -= luck.w * (luck.wd ?? 1) * 100 * dD / P;
      chance = { p3: a3 ? m3 / a3 : null, op3: oa3 ? om3 / oa3 : null, oft: ofa ? ofm / ofa : null, o_pts: dO / n, d_pts: dD / n, net_pts: (dO - dD) / n };
    }
    const ortg = (n * o + K * L) / (n + K), drtg = (n * d + K * L) / (n + K), pc = (n * pace + K * LP) / (n + K);
    out[t] = { team: t, n, ortg, drtg, pace: pc, net: ortg - drtg, ppg: rs.reduce((s, r) => s + r.pts, 0) / n, papg: rs.reduce((s, r) => s + r.opp_pts, 0) / n, o_raw: o0, d_raw: d0, pace_raw: pace, chance: chance && { ...chance, net_adj: o - d } };
  }
  return { teams: out, L, LP };
}
/** Points attendus des deux équipes selon le modèle (sans le marché). */
export function teamModel(T: ReturnType<typeof teamRatings>, dom: string, ext: string, P: NbaParams, f: { b2b_dom: number; b2b_ext: number; inj_dom: number; inj_ext: number; neutre?: boolean }) {
  const H = T.teams[dom], A = T.teams[ext];
  if (!H || !A) return null;
  const pace = H.pace * A.pace / T.LP;
  let ph = pace / 100 * H.ortg * A.drtg / T.L, pa = pace / 100 * A.ortg * H.drtg / T.L;
  const hm = f.neutre ? 0 : P.home + (['DEN', 'UTA'].includes(dom) ? P.alt : 0);
  ph += hm / 2 + (P.tb ?? 0) / 2; pa += -hm / 2 + (P.tb ?? 0) / 2;
  if (f.b2b_dom) { ph -= P.b2b / 2; pa += P.b2b / 2; }
  if (f.b2b_ext) { pa -= P.b2b / 2; ph += P.b2b / 2; }
  ph -= P.inj * f.inj_dom * 0.6; pa += P.inj * f.inj_dom * 0.4;
  pa -= P.inj * f.inj_ext * 0.6; ph += P.inj * f.inj_ext * 0.4;
  return { pts_dom: ph, pts_ext: pa, pace, hm };
}
export function blend(model: { pts_dom: number; pts_ext: number } | null, mkt: { spread_dom: number | null; total: number | null } | null, P: NbaParams) {
  let margin = model ? model.pts_dom - model.pts_ext : null, total = model ? model.pts_dom + model.pts_ext : null;
  const mm = mkt?.spread_dom != null ? -mkt.spread_dom : null, mt = mkt?.total ?? null;
  if (margin == null) margin = mm; else if (mm != null) margin = (1 - P.wm) * margin + P.wm * mm;
  if (total == null) total = mt; else if (mt != null) total = (1 - P.wt) * total + P.wt * mt;
  return { margin, total };
}
export const pWin = (margin: number, sd: number) => clamp(Phi(margin / sd), 0.02, 0.98);
/** Probabilité qu'une équipe gagne une période (égalité = perdu). */
export const pWinSeg = (m: number, sd: number) => clamp(1 - Phi((0.5 - m) / sd), 0.02, 0.98);

// ---------------------------------------------------------------- joueurs
export interface PAgg { id: string; team: string; gp: number; min: number; pts: number; fga: number; fgm: number; p3a: number; p3m: number; fta: number; ftm: number; reb: number; oreb: number; ast: number; stl: number; blk: number; tov: number; starts: number;
  games: { date: string; id: string; opp: string; home: number; min: number; pts: number; reb: number; ast: number; p3: number; p3a: number; starter: number; fga: number; fta: number; tov: number }[] }
export function playerAggs(boxes: any[]) {
  const out: Record<string, PAgg> = {};
  for (const b of [...boxes].sort((x, y) => x.date.localeCompare(y.date))) for (const r of b.joueurs as PRow[]) {
    const [id, team, min, pts, fgm, fga, p3m, p3a, ftm, fta, reb, oreb, ast, stl, blk, tov, st] = r;
    const a = out[id] ||= { id, team, gp: 0, min: 0, pts: 0, fga: 0, fgm: 0, p3a: 0, p3m: 0, fta: 0, ftm: 0, reb: 0, oreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, starts: 0, games: [] };
    a.team = team; a.gp++; a.min += min; a.pts += pts; a.fga += fga; a.fgm += fgm; a.p3a += p3a; a.p3m += p3m; a.fta += fta; a.ftm += ftm; a.reb += reb; a.oreb += oreb; a.ast += ast; a.stl += stl; a.blk += blk; a.tov += tov; a.starts += st;
    a.games.push({ date: b.date, id: b.id, opp: team === b.dom ? b.ext : b.dom, home: team === b.dom ? 1 : 0, min, pts, reb, ast, p3: p3m, p3a, starter: st, fga, fta, tov });
  }
  return out;
}
export const gmsc = (a: { pts: number; fgm: number; fga: number; fta: number; ftm: number; oreb: number; reb: number; stl: number; ast: number; blk: number; tov: number }) =>
  a.pts + 0.4 * a.fgm - 0.7 * a.fga - 0.4 * (a.fta - a.ftm) + 0.7 * a.oreb + 0.3 * (a.reb - a.oreb) + a.stl + 0.7 * a.ast + 0.7 * a.blk - a.tov;

/** Projection d'un joueur : minutes attendues × production par minute (saison mêlée à la saison passée), 3 points ramenés vers la normale. */
export function projectPlayer(a: PAgg, prior: any | null, ctx: { pace_ratio: number; def_ratio: number; usage_boost: number; reb_boost: number; min_boost: number; starter_now: boolean | null; margin_abs: number; min_override?: number }, P: NbaParams) {
  const g = a.games, L5 = g.slice(-5), L10 = g.slice(-10);
  const avg = (xs: any[], k: string) => xs.length ? xs.reduce((s, x) => s + x[k], 0) / xs.length : 0;
  const prMin = prior?.gp ? prior.min / prior.gp : null;
  let min = L5.length ? 0.5 * avg(L5, 'min') + 0.3 * (a.min / a.gp) + 0.2 * (prMin ?? a.min / a.gp) : (prMin ?? 15);
  const wasStarter = L5.length ? avg(L5, 'starter') >= 0.5 : (a.starts / Math.max(1, a.gp)) >= 0.5;
  if (ctx.starter_now === true && !wasStarter) min += 4; else if (ctx.starter_now === false && wasStarter) min -= 5;
  min = clamp(min + ctx.min_boost, 0, 42);
  if (min >= 28) min *= 1 - P.bl * Math.max(0, ctx.margin_abs - 6);
  if (ctx.min_override != null) min = ctx.min_override;
  // production par minute : saison en cours + saison passée (poids de 250 minutes, la saison passée pèse moins quand elle est loin)
  const K = 250, cm = a.min, pm = prior?.min || 0, wP = pm ? Math.min(1, K / pm) : 0;
  const rate = (cur: number, pri: number | undefined, def: number) => (cur + (pm ? (pri || 0) * wP : def * K)) / (cm + (pm ? pm * wP : K));
  const lg3 = 0.355;
  const p3pct = (a.p3m + (prior?.p3m || 0) + lg3 * 150) / (a.p3a + (prior?.p3a || 0) + 150);   // réussite à 3 points régressée
  const p3aR = rate(a.p3a, prior?.p3a, 0.08);
  const non3 = rate(a.pts - 3 * a.p3m, prior ? prior.pts - 3 * prior.p3m : undefined, 0.3);
  const pace = ctx.pace_ratio;
  const mu: Record<Stat, number> = {
    p3: min * p3aR * p3pct * pace * ctx.usage_boost,
    pts: min * (non3 + 3 * p3aR * p3pct) * pace * ctx.def_ratio * ctx.usage_boost,
    reb: min * rate(a.reb, prior?.reb, 0.17) * pace * ctx.reb_boost,
    ast: min * rate(a.ast, prior?.ast, 0.09) * pace * (1 + (ctx.usage_boost - 1) * 0.7),
    pra: 0,
  };
  mu.pra = mu.pts + mu.reb + mu.ast;
  // séries : réussite à 3 points sur 10 matchs comparée à sa normale
  const l3a = L10.reduce((s, x) => s + x.p3a, 0), l3m = L10.reduce((s, x) => s + x.p3, 0);
  const l3 = l3a >= 15 ? l3m / l3a : null;
  return { min, mu, p3pct, l10_p3pct: l3, l10_p3a: l3a, wasStarter };
}

/** Absents d'une équipe : part de son jeu (tirs, minutes, rebonds) et valeur perdue, pondérées par leur présence
 * sur les 10 derniers matchs de l'équipe (un joueur déjà absent depuis longtemps est déjà « dans » les stats de l'équipe). */
export function missingFor(PA: Record<string, PAgg>, past: any[], team: string, isOut: (id: string) => boolean) {
  const tg = past.filter(b => b.ext === team || b.dom === team).sort((x, y) => x.date.localeCompare(y.date)).slice(-10).map(b => b.id);
  const recent = new Set(tg);
  let u = 0, tot = 0, m = 0, rb = 0, rt = 0, imp = 0;
  const out: { id: string; share: number; impact: number; min: number }[] = [];
  for (const a of Object.values(PA)) {
    if (a.team !== team || a.gp < 3 || a.min / a.gp < 12) continue;
    const share = tg.length ? a.games.filter(g => recent.has(g.id)).length / tg.length : 0;
    if (share === 0) continue;
    const us = (a.fga + 0.44 * a.fta + a.tov) / a.gp;
    tot += us * share; rt += a.reb / a.gp * share;
    if (isOut(a.id)) {
      const impact = Math.max(0, gmsc(a) / a.min - 0.17) * (a.min / a.gp) * share;
      u += us * share; m += a.min / a.gp * share; rb += a.reb / a.gp * share; imp += impact;
      out.push({ id: a.id, share, impact, min: a.min / a.gp });
    }
  }
  const rest = tot - u, restR = rt - rb;
  return { u: rest > 0 ? u / rest : 0, m, rb: restR > 0 ? rb / restR : 0, imp, out };
}

/** Les minutes d'une équipe font 240 : on ramène la somme des minutes prévues des joueurs disponibles à 240. */
export function normalizeMinutes(raw: { id: string; min: number }[], total = 240) {
  const S = raw.reduce((t, r) => t + r.min, 0);
  if (S <= 0) return Object.fromEntries(raw.map(r => [r.id, r.min]));
  let f = total / S;
  const out: Record<string, number> = {};
  for (const r of raw) out[r.id] = Math.min(42, r.min * f);
  return out;
}
