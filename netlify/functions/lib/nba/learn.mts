// Apprentissage NBA chaque nuit : estimation a posteriori (les valeurs de départ, calées sur la saison 2025-26, servent de prudence).
import { r3 } from '../util.mts';
import * as M from './model.mts';

const LAB: Record<string, string> = { lw: 'Part de la correction « chance au tir » gardée', home: 'Avantage domicile (points)', wm: 'Poids des cotes sur l’écart', sm: 'Écart-type de l’écart final', tb: 'Correction du total', wt: 'Poids des cotes sur le total', st: 'Écart-type du total', sh: 'Écart-type d’une mi-temps', sq: 'Écart-type d’un quart-temps' };

export function learnNba(db: any, prev: M.NbaParams, boxes: any[], today: string) {
  const P: M.NbaParams = JSON.parse(JSON.stringify(prev));
  const D = M.NBA_DEFAULT;
  const changes: any[] = [], lessons: string[] = [];
  const set = (k: keyof M.NbaParams, v: number, n: number, eps: number) => { if (Math.abs(v - (prev as any)[k]) >= eps) { changes.push({ param: k, label: LAB[k] || k, avant: (prev as any)[k], apres: v, n }); (P as any)[k] = v; } };
  const nll = (y: number, mu: number, sd: number) => (y - mu) ** 2 / (2 * sd * sd) + Math.log(sd);
  const grid = (lo: number, hi: number, step: number, f: (x: number) => number) => { let bx = lo, bv = Infinity; for (let x = lo; x <= hi + 1e-9; x += step) { const v = f(x); if (v < bv) { bv = v; bx = x; } } return bx; };

  // 1. Équipes : avantage domicile, poids des cotes, écarts-types (matchs notés)
  const rows = db.predictions.filter((p: any) => p.type === 'Vainqueur' && p.y_m != null && p.mm != null).slice(-1500);
  if (rows.length >= 40) {
    const mrg = (r: any, h: number, wm: number) => { const mm = r.mm - (r.hm ?? D.home) + h; return r.km != null ? (1 - wm) * mm + wm * r.km : mm; };
    const h = grid(-1, 5, 0.1, x => rows.reduce((s: number, r: any) => s + nll(r.y_m, mrg(r, x, P.wm), P.sm), 0) + (x - D.home) ** 2 / (2 * M.PRIOR_SD.home ** 2));
    set('home', r3(h, 1)!, rows.length, 0.1);
    const mk = rows.filter((r: any) => r.km != null);
    if (mk.length >= 40) set('wm', r3(grid(0, 1, 0.02, x => mk.reduce((s: number, r: any) => s + nll(r.y_m, mrg(r, P.home, x), P.sm), 0) + (x - D.wm) ** 2 / (2 * M.PRIOR_SD.wm ** 2)), 2)!, mk.length, 0.02);
    set('sm', r3(grid(9, 18, 0.1, x => rows.reduce((s: number, r: any) => s + nll(r.y_m, mrg(r, P.home, P.wm), x), 0) + (x - D.sm) ** 2 / (2 * M.PRIOR_SD.sm ** 2)), 1)!, rows.length, 0.1);
    const tr = rows.filter((r: any) => r.mt != null && r.y_t != null);
    const tot = (r: any, tb: number, wt: number) => r.kt != null ? (1 - wt) * (r.mt + tb) + wt * r.kt : r.mt + tb;
    set('tb', r3(grid(-6, 8, 0.1, x => tr.reduce((s: number, r: any) => s + nll(r.y_t, tot(r, x, P.wt), P.st), 0) + (x - D.tb) ** 2 / (2 * 2 ** 2)), 1)!, tr.length, 0.1);
    const tk = tr.filter((r: any) => r.kt != null);
    if (tk.length >= 40) set('wt', r3(grid(0, 1, 0.02, x => tk.reduce((s: number, r: any) => s + nll(r.y_t, tot(r, P.tb, x), P.st), 0) + (x - D.wt) ** 2 / (2 * M.PRIOR_SD.wt ** 2)), 2)!, tk.length, 0.02);
    set('st', r3(grid(13, 26, 0.1, x => tr.reduce((s: number, r: any) => s + nll(r.y_t, tot(r, P.tb, P.wt), x), 0) + (x - D.st) ** 2 / (2 * M.PRIOR_SD.st ** 2)), 1)!, tr.length, 0.1);
    // périodes : écarts-types des mi-temps et quarts-temps autour de l'écart attendu
    const seg = rows.filter((r: any) => r.y_qd?.length >= 4);
    if (seg.length >= 40) {
      const W0 = 1241;   // la saison 2025-26 (1 241 matchs) sert de base
      const vh = seg.reduce((s: number, r: any) => s + (((r.y_qd[0] + r.y_qd[1]) - (r.y_qe[0] + r.y_qe[1])) - mrg(r, P.home, P.wm) / 2) ** 2, 0);
      const vq = seg.reduce((s: number, r: any) => s + [0, 1, 2, 3].reduce((u, i) => u + ((r.y_qd[i] - r.y_qe[i]) - mrg(r, P.home, P.wm) / 4) ** 2, 0), 0);
      set('sh', r3(Math.sqrt((vh + W0 * D.sh ** 2) / (seg.length + W0)), 2)!, seg.length, 0.05);
      set('sq', r3(Math.sqrt((vq + 4 * W0 * D.sq ** 2) / (4 * seg.length + 4 * W0)), 2)!, seg.length, 0.05);
    }
    // chance au tir (« PDO » du basket) : combien de la correction garder ? (matchs où elle a été mesurée)
    const lr = rows.filter((r: any) => r.lk != null && r.lw != null);
    if (lr.length >= 40) {
      const mrgL = (r: any, x: number) => { const mm = r.mm - r.lw * r.lk + x * r.lk - (r.hm ?? D.home) + P.home; return r.km != null ? (1 - P.wm) * mm + P.wm * r.km : mm; };
      set('lw', r3(grid(0, 2, 0.05, x => lr.reduce((s: number, r: any) => s + nll(r.y_m, mrgL(r, x), P.sm), 0) + (x - 1) ** 2 / (2 * 0.5 ** 2)), 2)!, lr.length, 0.05);
    }
    const acc = rows.filter((r: any) => r.resultat === 1).length / rows.length;
    lessons.push(`Vainqueurs : ${Math.round(acc * 100)} % de bons favoris sur ${rows.length} matchs. Domicile retenu : +${P.home} pt, poids des cotes ${Math.round(P.wm * 100)} % sur l'écart et ${Math.round(P.wt * 100)} % sur le total.`);
  } else lessons.push(`Équipes : ${rows.length} match(s) noté(s), j'attends 40 matchs avant de toucher aux réglages de départ (calés sur la saison passée).`);
  // parts du total par quart-temps : tous les matchs de la saison, la saison passée pèse comme 1 241 matchs
  if (boxes.length >= 30) {
    const q = [0, 1, 2, 3].map(i => boxes.reduce((s, b) => s + (b.qt_dom[i] || 0) + (b.qt_ext[i] || 0), 0)), T = q.reduce((a, b) => a + b);
    const W = 1241 * 225;
    P.qs = q.map((x, i) => r3((x + W * D.qs[i]) / (T + W), 4)!);
  }

  // 2. Joueurs : biais moyen et dispersion de chaque statistique, puis recalage par niveau de probabilité
  const pr = db.predictions.filter((p: any) => p.type === 'Projection joueur' && p.y && p.mu).slice(-6000);
  if (pr.length >= 300) {
    const W = 3000;
    for (const s of M.STATS) {
      const xs = pr.filter((p: any) => p.mu[s] > 0.2);
      if (xs.length < 300) continue;
      const sy = xs.reduce((t: number, p: any) => t + p.y[s], 0), sm = xs.reduce((t: number, p: any) => t + p.mu[s], 0), mbar = sm / xs.length;
      const sc = (sy + W * D.sc[s] * mbar) / (sm + W * mbar);
      const e = xs.reduce((t: number, p: any) => { const m = sc * p.mu[s]; return t + ((p.y[s] - m) ** 2 - (P.vd[s] ?? 0.005) * m * m); }, 0);
      const vc = (e + W * D.vc[s] * mbar * sc) / (sm * sc + W * mbar * sc);
      if (Math.abs(sc - prev.sc[s]) >= 0.01) changes.push({ param: `sc.${s}`, label: `Échelle ${M.STAT_LAB[s]}`, avant: prev.sc[s], apres: r3(sc, 3), n: xs.length });
      P.sc[s] = r3(sc, 3)!; P.vc[s] = r3(Math.max(0.5, vc), 3)!;
      const ratio = sy / (sm * prev.sc[s]);
      if (Math.abs(ratio - 1) > 0.04) lessons.push(`${M.STAT_LAB[s]} : les joueurs ont produit ${Math.round((ratio - 1) * 100)} % ${ratio > 1 ? 'de plus' : 'de moins'} que prévu (${xs.length} lignes). J'ajuste.`);
    }
    const edges = [0, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
    const calib: Record<string, any[]> = {};
    for (const s of M.STATS) {
      const pairs: { p: number; y: number }[] = [];
      for (const p of pr) for (const k of M.LADDER[s]) { const q = M.pAtLeast(s, p.mu[s], k, { ...P, calib: undefined }); if (q >= 0.05 && q <= 0.97) pairs.push({ p: q, y: +(p.y[s] >= k) }); }
      calib[s] = edges.slice(0, -1).map((lo, i) => { const b = pairs.filter(x => x.p >= lo && x.p < edges[i + 1]); return { lo, hi: edges[i + 1], n: b.length, prevu: b.length ? r3(b.reduce((t, x) => t + x.p, 0) / b.length) : null, reel: b.length ? r3(b.reduce((t, x) => t + x.y, 0) / b.length) : null }; }).filter(b => b.n);
      for (const b of calib[s]) { const se = Math.sqrt(b.prevu * (1 - b.prevu) / b.n); if (b.n >= 60 && Math.abs(b.reel - b.prevu) > 1.96 * se) lessons.push(`${M.STAT_LAB[s]} annoncés entre ${Math.round(b.lo * 100)} et ${Math.round(Math.min(1, b.hi) * 100)} % : réussite réelle ${Math.round(b.reel * 100)} % (${b.n} cas). Je recale.`); }
    }
    P.calib = calib;
  } else lessons.push(`Joueurs : ${pr.length} ligne(s) notée(s) ; les réglages de départ (calés sur 26 133 lignes de la saison passée) restent en place jusqu'à 300.`);

  // 3. Bilan des sélections (le plus parlant pour toi)
  for (const t of ['Sélection points', 'Objectif 80 %', 'Pari safe du jour', 'Totaux : période la plus sûre']) {
    const g = db.predictions.filter((p: any) => p.type === t && (p.resultat === 0 || p.resultat === 1));
    if (g.length >= 10) { const w = g.filter((p: any) => p.resultat === 1).length, e = g.reduce((s: number, p: any) => s + p.prob, 0); lessons.push(`${t} : ${w}/${g.length} gagnés (${Math.round(w / g.length * 100)} %) pour ${Math.round(e / g.length * 100)} % annoncés.`); }
  }
  return { params: P, entry: { date: today, changes, lessons, n_matchs: rows.length, n_joueurs: pr.length } };
}
