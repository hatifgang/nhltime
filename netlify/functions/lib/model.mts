// Modèle de prédiction : buts attendus (loi de Poisson) + paramètres appris (voir learn.mts).
import { poisson, clamp, logit, sigmoid } from './util.mts';

export interface Params {
  home: number;   // avantage domicile (fraction ajoutée aux buts attendus du domicile, retirée à l'extérieur)
  form: number;   // poids de la forme sur 10 matchs
  b2b: number;    // pénalité 2e match en 2 soirs
  goalie: number; // exposant appliqué à l'effet du gardien partant
  inj: number;    // poids des absences importantes
  h2h: number;    // poids des confrontations directes
  wm: number;     // poids du modèle face au marché (0 = marché seul, 1 = modèle seul)
  ag: number;     // échelle des taux de buts joueurs
  aa: number;     // échelle des taux de passes joueurs
  ap: number;     // échelle des taux de points joueurs
  vthr: number;   // seuil d'écart (points de probabilité) pour signaler une « valeur potentielle »
  rg: number; ra: number; rp: number; // dispersion (paquets) des buts, passes, points : grand = loi de Poisson
  xg: number;     // échelle des buts attendus des équipes, apprise sur les scores réels
  as: number; rs: number; // échelle et dispersion des tirs cadrés joueurs, apprises sur les tirs réels
  wt: number;     // poids du marché (cote du total de buts + vainqueur) dans les buts attendus de chaque équipe
  wi: number;     // poids du modèle « part des buts sur la glace » dans les points joueurs
  gD: number; aD: number; pD: number; // échelles propres aux défenseurs (buts, passes, points)
  bG: number; bS: number; bC: number; bX: number; rr: number; // force des équipes : poids buts (corrigés PDO), tirs, Corsi, xG ; part des écarts conservée
}
export const PRIORS: Record<keyof Params, { v: number; sd: number; min: number; max: number; label: string }> = {
  home: { v: 0.04, sd: 0.03, min: -0.02, max: 0.12, label: 'Avantage domicile' },
  form: { v: 0.10, sd: 0.10, min: 0, max: 0.40, label: 'Poids de la forme récente' },
  b2b: { v: 0.04, sd: 0.04, min: 0, max: 0.15, label: 'Pénalité 2e match en 2 soirs' },
  goalie: { v: 1.0, sd: 0.5, min: 0, max: 2, label: 'Poids du gardien partant' },
  inj: { v: 0.20, sd: 0.20, min: 0, max: 0.8, label: 'Poids des absences' },
  h2h: { v: 0.04, sd: 0.05, min: 0, max: 0.2, label: 'Poids des confrontations directes' },
  wm: { v: 0.5, sd: 0.25, min: 0, max: 1, label: 'Confiance du modèle face au marché' },
  ag: { v: 1, sd: 0.15, min: 0.6, max: 1.5, label: 'Échelle buts joueurs' },
  aa: { v: 1, sd: 0.15, min: 0.6, max: 1.5, label: 'Échelle passes joueurs' },
  ap: { v: 1, sd: 0.15, min: 0.6, max: 1.5, label: 'Échelle points joueurs' },
  vthr: { v: 0.05, sd: 0, min: 0.04, max: 0.12, label: 'Seuil de valeur potentielle' },
  rg: { v: 12, sd: 0.6, min: 1.5, max: 60, label: 'Dispersion des buts joueurs' },
  ra: { v: 8, sd: 0.6, min: 1.5, max: 60, label: 'Dispersion des passes joueurs' },
  rp: { v: 5, sd: 0.6, min: 1.5, max: 60, label: 'Dispersion des points joueurs' },
  xg: { v: 1, sd: 0.08, min: 0.8, max: 1.2, label: 'Échelle des buts attendus (équipes)' },
  as: { v: 1, sd: 0.1, min: 0.7, max: 1.3, label: 'Échelle des tirs cadrés joueurs' },
  rs: { v: 8, sd: 0.6, min: 1.5, max: 60, label: 'Dispersion des tirs cadrés joueurs' },
  wt: { v: 0.6, sd: 0.2, min: 0, max: 1, label: 'Poids du marché dans les buts attendus' },
  wi: { v: 0.5, sd: 0.2, min: 0, max: 1, label: 'Poids du modèle sur la glace (points joueurs)' },
  gD: { v: 1, sd: 0.15, min: 0.5, max: 1.6, label: 'Échelle buts des défenseurs' },
  aD: { v: 1, sd: 0.15, min: 0.5, max: 1.6, label: 'Échelle passes des défenseurs' },
  pD: { v: 1, sd: 0.15, min: 0.5, max: 1.6, label: 'Échelle points des défenseurs' },
  bG: { v: 0.1, sd: 0.15, min: 0, max: 1, label: 'Poids des buts (corrigés du PDO)' },
  bS: { v: 0.2, sd: 0.15, min: 0, max: 1, label: 'Poids des tirs' },
  bC: { v: 0, sd: 0.15, min: 0, max: 1, label: 'Poids du Corsi' },
  bX: { v: 0.7, sd: 0.15, min: 0, max: 1, label: 'Poids des buts attendus (xG, position des tirs)' },
  rr: { v: 0.9, sd: 0.1, min: 0.4, max: 1, label: 'Part des écarts entre équipes conservée' },
};
export const defaultParams = (): Params => Object.fromEntries(Object.entries(PRIORS).map(([k, p]) => [k, p.v])) as any;

/** Caractéristiques d'un match, indépendantes des paramètres (stockées pour l'apprentissage). */
export interface GameFeat {
  lg: number; gfh: number; gah: number; gfa: number; gaa: number;
  form_h: number; form_a: number; b2b_h: number; b2b_a: number;
  g_h: number; g_a: number;      // effet gardien (ratio buts accordés partant / équipe), 1 si inconnu
  inj_h: number; inj_a: number;  // part offensive perdue par absences
  h2h: number;                   // part de victoires domicile - 0.5 (0 si < 2 matchs)
  mkt_h: number | null;          // probabilité marché sans marge (domicile, prolongation incluse)
  mkt_lh?: number | null; mkt_la?: number | null; // buts attendus déduits des cotes (total + vainqueur)
  // composantes de la force (par match) : [buts corrigés PDO, tirs, Corsi, xG] pour, puis contre ; null si absente
  cmp_h?: (number | null)[]; cmp_a?: (number | null)[];
}
/** Force d'une équipe (buts pour / contre par match) à partir de ses composantes, avec des poids appris. */
export function teamStrength(c: (number | null)[], lg: number, p: Params) {
  // départ calé sur 1 220 matchs de 2025-26 rejoués : xG 70 %, tirs 20 %, buts corrigés PDO 10 % (log-loss 0,6828 contre 0,6857 avant)
  const w = [p.bG ?? 0.1, p.bS ?? 0.2, p.bC ?? 0, p.bX ?? 0.7];
  let gf = 0, ga = 0, sw = 0;
  for (let i = 0; i < 4; i++) if (c[i] != null && c[i + 4] != null && w[i] > 0) { gf += w[i] * c[i]!; ga += w[i] * c[i + 4]!; sw += w[i]; }
  if (!sw) { gf = c[0] ?? lg; ga = c[4] ?? lg; sw = 1; }
  const R = p.rr ?? 0.9;
  return { gf: lg + R * (gf / sw - lg), ga: lg + R * (ga / sw - lg) };
}

export function gameProbs(f: GameFeat, p: Params) {
  if (f.cmp_h && f.cmp_a) { const H = teamStrength(f.cmp_h, f.lg, p), A = teamStrength(f.cmp_a, f.lg, p); f = { ...f, gfh: H.gf, gah: H.ga, gfa: A.gf, gaa: A.ga }; }
  let lh = f.lg * (f.gfh / f.lg) * (f.gaa / f.lg) * (1 + p.home) * (p.xg ?? 1);
  let la = f.lg * (f.gfa / f.lg) * (f.gah / f.lg) * (1 - p.home) * (p.xg ?? 1);
  lh *= 1 + p.form * f.form_h; la *= 1 + p.form * f.form_a;
  if (f.b2b_h) { lh *= 1 - p.b2b; la *= 1 + p.b2b; }
  if (f.b2b_a) { la *= 1 - p.b2b; lh *= 1 + p.b2b; }
  la *= clamp(f.g_h ** p.goalie, 0.8, 1.25);
  lh *= clamp(f.g_a ** p.goalie, 0.8, 1.25);
  lh *= Math.max(0.85, 1 - p.inj * f.inj_h); la *= Math.max(0.85, 1 - p.inj * f.inj_a);
  lh *= 1 + p.h2h * f.h2h; la *= 1 - p.h2h * f.h2h;
  // Le marché des totaux est très efficace : on mêle (moyenne géométrique) nos buts attendus et les siens.
  const wt = p.wt ?? 0;
  if (f.mkt_lh && f.mkt_la && wt > 0) { lh = Math.exp((1 - wt) * Math.log(lh) + wt * Math.log(f.mkt_lh)); la = Math.exp((1 - wt) * Math.log(la) + wt * Math.log(f.mkt_la)); }
  let ph = 0, pa = 0, pt = 0;
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
    const q = poisson(i, lh) * poisson(j, la);
    if (i > j) ph += q; else if (j > i) pa += q; else pt += q;
  }
  const shareH = clamp(0.5 + 0.5 * (lh - la) / (lh + la), 0.4, 0.6);
  const model = clamp(ph + pt * shareH, 0.02, 0.98);
  const final = f.mkt_h != null ? sigmoid(p.wm * logit(model) + (1 - p.wm) * logit(clamp(f.mkt_h, 0.02, 0.98))) : model;
  return { lh, la, p_reg_h: ph, p_reg_a: pa, p_tie: pt, model_h: model, final_h: final };
}

/** Probabilité de victoire domicile (prolongation incluse) pour des buts attendus donnés. */
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

export const pAtLeastOne = (lam: number) => 1 - Math.exp(-Math.max(0, lam));
/** P(au moins 1) avec dispersion (binomiale négative) : les points d'un joueur arrivent par paquets,
 * ce qui rend « au moins 1 » moins probable que ne le dit Poisson, surtout pour les gros producteurs. */
/** P(X >= k) pour une binomiale négative de moyenne lam et dispersion r. */
export function pAtLeastK(lam: number, k: number, r = 8) {
  const q = lam / (r + lam);
  let pk = (r / (r + lam)) ** r, cdf = 0;
  for (let i = 0; i < k; i++) { cdf += pk; pk = pk * (i + r) / (i + 1) * q; }
  return Math.max(0, 1 - cdf);
}
/** P(X = k) pour la même loi (vraisemblance complète des tirs). */
export function pmfNB(lam: number, k: number, r: number) {
  const q = lam / (r + lam);
  let p = (r / (r + lam)) ** r;
  for (let i = 0; i < k; i++) p = p * (i + r) / (i + 1) * q;
  return p;
}
/** Recalage final : on corrige une probabilité par l'écart réellement observé à ce niveau de confiance,
 * avec prudence (un niveau vu 30 fois ne pèse qu'à moitié). */
export function calibrate(table: any[] | undefined, p: number) {
  if (!table || p == null) return p;
  const b = table.find((x: any) => p >= x.lo && p < x.hi);
  if (!b || !b.n) return p;
  return clamp(p + (b.n / (b.n + 30)) * (b.reel - b.prevu), 0.01, 0.97);
}

export const pNB = (lam: number, r: number) => r >= 200 ? pAtLeastOne(lam) : 1 - (r / (r + Math.max(0, lam))) ** r;

/** « Les deux équipes marquent » en temps réglementaire : match entier et chaque période.
 * Base : buts attendus de chaque équipe × part des buts de la période (ligue), loi de Poisson,
 * puis recalage logit a + b·logit(p) appris sur les vrais scores (les équipes menées poussent et sortent
 * leur gardien : les deux marquent plus souvent que ne le dit le hasard pur, surtout en 3e période).
 * Valeurs de départ ajustées sur 195 matchs de la saison 2026-27 (scores nhl.com, période par période). */
export const BTTS_DEFAULT = { s: [1, 0.293, 0.346, 0.361], a: [0.36, 0.24, 0.10, 0.10], b: [1.10, 0.95, 0.90, 1.05], n: 0 };
export function bttsProbs(lh: number, la: number, B: any = BTTS_DEFAULT) {
  const P1 = (l: number) => 1 - Math.exp(-Math.max(0, l));
  return [0, 1, 2, 3].map(k => {
    const s = B?.s?.[k] ?? BTTS_DEFAULT.s[k], a = B?.a?.[k] ?? BTTS_DEFAULT.a[k], b = B?.b?.[k] ?? BTTS_DEFAULT.b[k];
    const raw = clamp(P1(lh * s) * P1(la * s), 0.01, 0.99);
    return { p: clamp(sigmoid(a + b * logit(raw)), 0.02, 0.98), dom: P1(lh * s), ext: P1(la * s) };
  });
}
