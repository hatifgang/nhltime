// Modèle hockey européen : buts attendus de chaque équipe (attaque × défense adverse × domicile), loi de Poisson
// avec un léger surplus de matchs nuls en 60 minutes (mesuré), prolongation et tirs au but = 1 but de plus au score final.
import { clamp } from '../util.mts';
import type { EGame } from './sources.mts';

export interface EParams { K: number; tau: number; wPrior: number; calib?: Record<string, any[]> }
export const E_DEFAULT: EParams = { K: 8, tau: 0.12, wPrior: 0.5 };

/** Score à la fin du temps réglementaire (prolongation et tirs au but : égalité au plus petit score). */
export const regScore = (g: EGame) => g.fin === 'REG' ? [g.hs!, g.as!] : g.reg_h != null && g.reg_a != null && g.reg_h === g.reg_a ? [g.reg_h, g.reg_a] : [Math.min(g.hs!, g.as!), Math.min(g.hs!, g.as!)];

export function leagueStats(done: EGame[]) {
  let H = 0, A = 0, n = 0, ties = 0;
  for (const g of done) { const [h, a] = regScore(g); H += h; A += a; n++; if (h === a) ties++; }
  return { n, H: n ? H / n : 2.8, A: n ? A / n : 2.4, m: n ? (H + A) / (2 * n) : 2.6, ties: n ? ties / n : 0.22 };
}
export interface TeamRate { team: string; gp: number; gf: number; ga: number; rf: number; ra: number; form: string[] }
/** Taux de buts marqués / encaissés par match (60 min), ramenés vers la moyenne (K matchs) ou vers la saison passée. */
export function teamRates(done: EGame[], prior: Record<string, { rf: number; ra: number }> | null, P: EParams) {
  const L = leagueStats(done), T: Record<string, TeamRate> = {};
  for (const g of [...done].sort((x, y) => x.date.localeCompare(y.date))) {
    const [h, a] = regScore(g);
    for (const [t, f, c, w] of [[g.dom, h, a, g.hs! > g.as!], [g.ext, a, h, g.as! > g.hs!]] as const) {
      const r = T[t] ||= { team: t, gp: 0, gf: 0, ga: 0, rf: 0, ra: 0, form: [] };
      r.gp++; r.gf += f; r.ga += c; r.form.push(w ? 'V' : g.fin === 'REG' ? 'D' : 'P');
    }
  }
  for (const r of Object.values(T)) {
    const pr = prior?.[r.team];
    const pf = pr ? L.m * (1 - P.wPrior + P.wPrior * pr.rf) : L.m, pa = pr ? L.m * (1 - P.wPrior + P.wPrior * pr.ra) : L.m;
    r.rf = (r.gf + P.K * pf) / (r.gp + P.K); r.ra = (r.ga + P.K * pa) / (r.gp + P.K);
    r.form = r.form.slice(-10);
  }
  return { L, T };
}
/** Rapports « taux / moyenne » d'une saison complète, servant de point de départ à la suivante. */
export function priorsFrom(done: EGame[]) {
  const { L, T } = teamRates(done, null, { ...E_DEFAULT, K: 0 });
  return Object.fromEntries(Object.values(T).map(r => [r.team, { rf: r.gf / r.gp / L.m, ra: r.ga / r.gp / L.m }]));
}
const pois = (k: number, l: number) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return Math.exp(-l) * l ** k / f; };

export function gameMarkets(lh: number, la: number, P: EParams) {
  const N = 12, M: number[][] = [];
  let s = 0;
  for (let i = 0; i < N; i++) { M[i] = []; for (let j = 0; j < N; j++) { const q = pois(i, lh) * pois(j, la) * (i === j ? 1 + P.tau : 1); M[i][j] = q; s += q; } }
  let ph = 0, pd = 0, pa = 0, btts = 0; const tot: number[] = new Array(2 * N + 2).fill(0);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const q = M[i][j] / s; if (i > j) ph += q; else if (i < j) pa += q; else pd += q; if (i > 0 && j > 0) btts += q; tot[i + j + (i === j ? 1 : 0)] += q; }
  const share = clamp(0.5 + 0.5 * (lh - la) / (lh + la), 0.4, 0.6);
  const over = (line: number) => tot.reduce((t, q, k) => t + (k > line ? q : 0), 0);
  return { lh, la, ph, pd, pa, win_h: ph + pd * share, win_a: pa + pd * (1 - share), btts, over45: over(4.5), over55: over(5.5), over35: over(3.5) };
}
export function predict(rates: ReturnType<typeof teamRates>, dom: string, ext: string, P: EParams) {
  const { L, T } = rates, h = T[dom], a = T[ext];
  if (!h || !a) return null;
  const lh = h.rf * a.ra / L.m * (L.H / L.m), la = a.rf * h.ra / L.m * (L.A / L.m);
  return gameMarkets(lh, la, P);
}

/** Les paris proposés pour un match, avec la façon de les noter. */
export function marketsList(dom: string, ext: string, mk: ReturnType<typeof gameMarkets>) {
  return [
    { code: 'win_h', label: `${dom} gagne (prolongation incluse)`, p: mk.win_h }, { code: 'win_a', label: `${ext} gagne (prolongation incluse)`, p: mk.win_a },
    { code: '1', label: `${dom} gagne en 60 min`, p: mk.ph }, { code: '2', label: `${ext} gagne en 60 min`, p: mk.pa },
    { code: '1X', label: `${dom} ou nul (60 min)`, p: mk.ph + mk.pd }, { code: 'X2', label: `${ext} ou nul (60 min)`, p: mk.pa + mk.pd },
    { code: 'o45', label: 'Plus de 4,5 buts', p: mk.over45 }, { code: 'u45', label: 'Moins de 4,5 buts', p: 1 - mk.over45 },
    { code: 'o55', label: 'Plus de 5,5 buts', p: mk.over55 }, { code: 'u55', label: 'Moins de 5,5 buts', p: 1 - mk.over55 },
    { code: 'btts', label: 'Les deux équipes marquent (60 min)', p: mk.btts }, { code: 'nbtts', label: 'Une équipe ne marque pas (60 min)', p: 1 - mk.btts },
  ];
}
export function gradeMarket(code: string, g: EGame): number | null {
  if (!g.done || g.hs == null || g.as == null) return null;
  const [h, a] = regScore(g), t = g.hs + g.as;
  switch (code) {
    case 'win_h': return +(g.hs > g.as); case 'win_a': return +(g.as > g.hs);
    case '1': return +(h > a); case '2': return +(a > h); case '1X': return +(h >= a); case 'X2': return +(a >= h);
    case 'o45': return +(t > 4.5); case 'u45': return +(t < 4.5); case 'o55': return +(t > 5.5); case 'u55': return +(t < 5.5);
    case 'btts': return +(h > 0 && a > 0); case 'nbtts': return +!(h > 0 && a > 0);
  }
  return null;
}
export function calibrate(table: any[] | undefined, p: number) {
  const b = table?.find((x: any) => p >= x.lo && p < x.hi);
  if (!b || !b.n) return p;
  return clamp(p + (b.n / (b.n + 60)) * (b.reel - b.prevu), 0.02, 0.97);
}
