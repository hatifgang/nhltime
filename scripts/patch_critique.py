B = 'netlify/functions/lib/'


def patch(path, pairs):
    s = open(B + path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (path, old[:90])
        s = s.replace(old, new, 1)
    open(B + path, 'w', encoding='utf-8').write(s)


# ------------------------------------------------------------------ model.mts
patch('model.mts', [
    ("  xg: number;     // échelle des buts attendus des équipes, apprise sur les scores réels\n}",
     "  xg: number;     // échelle des buts attendus des équipes, apprise sur les scores réels\n"
     "  as: number; rs: number; // échelle et dispersion des tirs cadrés joueurs, apprises sur les tirs réels\n}"),
    ("  xg: { v: 1, sd: 0.08, min: 0.8, max: 1.2, label: 'Échelle des buts attendus (équipes)' },",
     "  xg: { v: 1, sd: 0.08, min: 0.8, max: 1.2, label: 'Échelle des buts attendus (équipes)' },\n"
     "  as: { v: 1, sd: 0.1, min: 0.7, max: 1.3, label: 'Échelle des tirs cadrés joueurs' },\n"
     "  rs: { v: 8, sd: 0.6, min: 1.5, max: 60, label: 'Dispersion des tirs cadrés joueurs' },"),
    ("export const pNB = (lam: number, r: number) =>",
     """/** P(X >= k) pour une binomiale négative de moyenne lam et dispersion r. */
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

export const pNB = (lam: number, r: number) =>"""),
])

# ------------------------------------------------------------------ learn.mts
patch('learn.mts', [
    ("import { gameProbs, PRIORS, pNB, type Params, type GameFeat } from './model.mts';",
     "import { gameProbs, PRIORS, pNB, pAtLeastK, pmfNB, type Params, type GameFeat } from './model.mts';"),
    ("const TEAM_KEYS: (keyof Params)[] = ['home', 'form', 'b2b', 'goalie', 'inj', 'h2h', 'wm'];",
     "const TEAM_KEYS: (keyof Params)[] = ['home', 'form', 'b2b', 'goalie', 'inj', 'h2h'];   // wm a son propre test (1 réglage)"),
    ("const LR = { 1: 1.92, 2: 3.0, 7: 7.0 } as const;", "const LR = { 1: 1.92, 2: 3.0, 6: 6.3, 7: 7.0 } as const;"),
    ("    const proven = gain >= LR[7];\n    if (!proven) lessons.push(`Réglages d'équipe : les ${rows.length} matchs évalués ne prouvent pas encore qu'il faut changer (gain ${gain.toFixed(2)} < ${LR[7]}). Je garde les réglages de départ.`);",
     "    const proven = gain >= LR[6];\n    if (!proven) lessons.push(`Réglages d'équipe : les ${rows.length} matchs évalués ne prouvent pas encore qu'il faut changer (gain ${gain.toFixed(2)} < ${LR[6]}). Je garde les réglages de départ.`);"),
    ("  // 2b. Buts attendus des équipes contre buts réellement marqués (après-match)",
     """  // 1b. Confiance face au marché : testée seule (1 réglage), pour pouvoir admettre vite que les cotes font mieux.
  const mk = rows.filter(r => r.f.mkt_h != null);
  if (mk.length >= 30) {
    const W = PRIORS.wm;
    const nllW = (w: number) => mk.reduce((s, r) => s + ll(gameProbs(r.f, { ...params, wm: w }).final_h, r.y), 0);
    let bw = W.v, bv = Infinity;
    for (let w = W.min; w <= W.max + 1e-9; w += 0.02) { const v = nllW(w) + (w - W.v) ** 2 / (2 * W.sd ** 2); if (v < bv) { bv = v; bw = w; } }
    const gain = nllW(W.v) - nllW(bw);
    const target = r3(gain >= LR[1] ? bw : W.v, 2)!;
    if (Math.abs(target - prevParams.wm) >= 0.02) { changes.push({ param: 'wm', label: W.label, avant: prevParams.wm, apres: target, n: mk.length }); params.wm = target; }
    if (gain < LR[1]) lessons.push(`Modèle contre marché : sur ${mk.length} matchs, l'écart n'est pas encore prouvé (gain ${gain.toFixed(2)} < ${LR[1]}). Poids du modèle maintenu à ${Math.round(params.wm * 100)} %.`);
  }

  // 2a. Tirs cadrés : vraisemblance complète du nombre de tirs (plus informative que « au moins 2 »)
  const shotRows = Object.values(Object.fromEntries((db.postmatch?.players || []).filter((x: any) => x.tirs != null && x.tirs_exp > 0 && x.res !== 'N/J').map((x: any) => [`${x.date}-${x.player_id}`, x]))) as any[];
  if (shotRows.length >= 150) {
    const A = PRIORS.as, R = PRIORS.rs;
    const nllS = (a: number, r: number) => shotRows.reduce((s, x) => s - Math.log(Math.max(1e-9, pmfNB(x.tirs_exp * a, x.tirs, r))), 0);
    let best = { a: A.v, r: R.v, v: Infinity };
    for (let a = A.min; a <= A.max + 1e-9; a += 0.01) for (let k = 0; k <= 30; k++) {
      const r = R.min * (R.max / R.min) ** (k / 30);
      const v = nllS(a, r) + (a - A.v) ** 2 / (2 * A.sd ** 2) + (Math.log(r) - Math.log(R.v)) ** 2 / (2 * R.sd ** 2);
      if (v < best.v) best = { a, r, v };
    }
    const gain = nllS(A.v, R.v) - nllS(best.a, best.r);
    const a = r3(gain >= LR[2] ? best.a : A.v, 3)!, r = r3(gain >= LR[2] ? best.r : R.v, 2)!;
    if (Math.abs(a - prevParams.as) >= 0.005) { changes.push({ param: 'as', label: A.label, avant: prevParams.as, apres: a, n: shotRows.length }); params.as = a; }
    if (Math.abs(r - prevParams.rs) / prevParams.rs >= 0.05) { changes.push({ param: 'rs', label: R.label, avant: prevParams.rs, apres: r, n: shotRows.length }); params.rs = r; }
  }

  // 2b. Buts attendus des équipes contre buts réellement marqués (après-match)"""),
    ("  return { params, entry: { date: today, changes, lessons, metrics, segments: segs } };",
     """  // 7. Recalage final : pour chaque type, ce que disent les résultats réels à chaque niveau de confiance,
  // recalculé avec les réglages actuels (on ne corrige pas deux fois une erreur déjà apprise).
  const edges = [0, 0.35, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
  const table = (pairs: { p: number; y: number }[]) => edges.slice(0, -1).map((lo, i) => {
    const b = pairs.filter(x => x.p >= lo && x.p < edges[i + 1]);
    return { lo, hi: edges[i + 1], n: b.length, prevu: b.length ? r3(b.reduce((s, x) => s + x.p, 0) / b.length) : null, reel: b.length ? r3(b.reduce((s, x) => s + x.y, 0) / b.length) : null };
  }).filter(b => b.n);
  const lamRows = (typ: string, a: number, r: number) => graded.filter(p => p.type === typ && p.lam_base).map(p => ({ p: pNB(p.lam_base * a, r), y: p.resultat }));
  const calib: any = {
    point: table(lamRows('Point joueur', params.ap, params.rp)),
    but: table(lamRows('But joueur', params.ag, params.rg)),
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

  return { params, entry: { date: today, changes, lessons, metrics, segments: segs, calib } };"""),
])

# ------------------------------------------------------------------ pipeline.mts
s = open(B + 'pipeline.mts', encoding='utf-8').read()
start = s.index('/** P(X >= k) pour une binomiale négative de moyenne lam et dispersion r (r grand = Poisson). */')
end = s.index('function fmtSec(s: any) {')
s = s[:start] + s[end:]
open(B + 'pipeline.mts', 'w', encoding='utf-8').write(s)
patch('pipeline.mts', [
    ("import { gameProbs, defaultParams, pNB, PRIORS, type Params, type GameFeat } from './model.mts';",
     "import { gameProbs, defaultParams, pNB, pAtLeastK, calibrate, PRIORS, type Params, type GameFeat } from './model.mts';"),
    ("          p_but: r3(pNB(p.g_rate * teamF / params.xg * ppm(p) * params.ag, params.rg)),",
     "          p_but: r3(calibrate(CAL.but, pNB(p.g_rate * teamF / params.xg * ppm(p) * params.ag, params.rg))),"),
    ("          p_point: r3(regular(p, pNB(p.p_rate * teamF / params.xg * ppm(p) * params.ap, params.rp))),",
     "          p_point: r3(calibrate(CAL.point, regular(p, pNB(p.p_rate * teamF / params.xg * ppm(p) * params.ap, params.rp)))),"),
    ("          tirs_ce_soir: r3((p.s_rate || 0) * shotF * Math.sqrt((p.toi_eff || p.toi_sec || 1) / (p.toi_sec || p.toi_eff || 1)), 2),\n"
     "          p_tirs2: r3(pAtLeastK((p.s_rate || 0) * shotF * Math.sqrt((p.toi_eff || p.toi_sec || 1) / (p.toi_sec || p.toi_eff || 1)), 2)),\n"
     "          p_tirs3: r3(pAtLeastK((p.s_rate || 0) * shotF * Math.sqrt((p.toi_eff || p.toi_sec || 1) / (p.toi_sec || p.toi_eff || 1)), 3)),",
     "          tirs_ce_soir: r3(lamShots(p), 2),\n"
     "          p_tirs2: r3(calibrate(CAL.tirs2, pAtLeastK(lamShots(p), 2, params.rs))),\n"
     "          p_tirs3: r3(calibrate(CAL.tirs3, pAtLeastK(lamShots(p), 3, params.rs))),"),
    ("      const ppm = (p: any) => 1 + (p.pp_share || 0) * (pkF - 1);",
     "      const ppm = (p: any) => 1 + (p.pp_share || 0) * (pkF - 1);\n"
     "      const CAL = (params as any).calib || {};\n"
     "      const lamShots = (p: any) => (p.s_rate || 0) * shotF * Math.sqrt((p.toi_eff || p.toi_sec || 1) / (p.toi_sec || p.toi_eff || 1)) * params.as;"),
])

# ------------------------------------------------------------------ page : tableau de recalage dans Apprentissage
P = 'public/index.html'
s = open(P, encoding='utf-8').read()
old = "   <h2>Journal critique</h2>"
assert old in s
s = s.replace(old, """   <h2>Recalage final (résultats réels par niveau de confiance)</h2>
   <p class="lead">Avant d'afficher une probabilité, je la compare à ce qui s'est vraiment passé quand j'annonçais le même niveau, et je la corrige avec prudence (un niveau vu 30 fois ne compte qu'à moitié).</p>
   ${(()=>{ const C = P.calib||{}; const lab = {point:'Au moins 1 point', but:'Au moins 1 but', tirs2:'2 tirs cadrés et plus', tirs3:'3 tirs cadrés et plus'};
     const rowsC = Object.entries(C).flatMap(([k,bins])=>(bins||[]).map(b=>({k:lab[k]||k, ...b})));
     return rowsC.length ? table([['Pari',r=>[esc(r.k),r.k]],['Annoncé',r=>[`${Math.round(r.lo*100)}–${Math.round(Math.min(1,r.hi)*100)} %`,r.lo],1],['Cas',r=>[r.n,r.n],1],['Prévu',r=>[pct(r.prevu),r.prevu],1],['Réel',r=>[pct(r.reel),r.reel],1],['Écart',r=>{const e=r.reel-r.prevu;return [`<span class="chip ${Math.abs(e)<0.05?'':e>0?'good':'bad'}">${e>0?'+':''}${Math.round(e*100)} pts</span>`,e]},1]], rowsC) : '<div class="empty">Pas encore assez de résultats.</div>'; })()}
   <h2>Journal critique</h2>""", 1)
open(P, 'w', encoding='utf-8').write(s)
print('ok')
