// Rejeu jour par jour de la saison 2025-26 (KHL, SHL, Liiga) : chaque match prédit avec les seuls matchs déjà joués.
import fs from 'node:fs';
import { khlSeason, liigaSeason, shlSeason } from '../netlify/functions/lib/europe/sources.mts';
import { teamRates, predict, marketsList, gradeMarket, E_DEFAULT, type EParams } from '../netlify/functions/lib/europe/model.mts';

const cache = process.argv[2];
const load = async () => {
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const d = { KHL: await khlSeason('2025-2026', 2025), SHL: await shlSeason('2025'), Liiga: await liigaSeason(2026) };
  fs.writeFileSync(cache, JSON.stringify(d)); return d;
};
const data = await load();
const run = (P: EParams, verbose = false) => {
  let ll = 0, n = 0; const bins: Record<string, number[]> = {}; const byMk: Record<string, number[]> = {};
  for (const lg of ['KHL', 'SHL', 'Liiga']) {
    const games = (data[lg] as any[]).filter(g => g.done).sort((a, b) => a.date.localeCompare(b.date));
    const dates = [...new Set(games.map(g => g.date))];
    for (const d of dates) {
      const past = games.filter(g => g.date < d);
      if (past.length < 40) continue;
      const R = teamRates(past, null, P);
      for (const g of games.filter(x => x.date === d)) {
        const mk = predict(R, g.dom, g.ext, P); if (!mk) continue;
        for (const m of marketsList(g.dom, g.ext, mk)) {
          const y = gradeMarket(m.code, g); if (y == null) continue;
          const p = Math.min(0.99, Math.max(0.01, m.p));
          if (['win_h', '1', 'o55', 'btts', '1X'].includes(m.code)) { ll -= y ? Math.log(p) : Math.log(1 - p); n++; }
          if (p > 0.5) { const b = `${lg}|${Math.floor(p * 10) / 10}`; (bins[b] ||= [0, 0, 0]); bins[b][0]++; bins[b][1] += p; bins[b][2] += y;
            const k = `${lg}|${m.code}`; (byMk[k] ||= [0, 0, 0]); byMk[k][0]++; byMk[k][1] += p; byMk[k][2] += y; }
        }
      }
    }
  }
  if (verbose) {
    console.log('Paris > 50 % par niveau (n, prévu, réel) :');
    for (const [k, v] of Object.entries(bins).sort()) console.log(' ', k, v[0], (v[1] / v[0] * 100).toFixed(1), (v[2] / v[0] * 100).toFixed(1));
    console.log('Par marché (> 50 %) :');
    for (const [k, v] of Object.entries(byMk).sort()) console.log(' ', k, v[0], (v[1] / v[0] * 100).toFixed(1), (v[2] / v[0] * 100).toFixed(1));
  }
  return ll / n;
};
let best: any = null;
for (const K of [4, 8, 12, 20]) for (const tau of [0, 0.08, 0.15, 0.25]) { const v = run({ ...E_DEFAULT, K, tau }); if (!best || v < best.v) best = { K, tau, v }; }
console.log('meilleur réglage', JSON.stringify(best));
run({ ...E_DEFAULT, K: best.K, tau: best.tau }, true);

// ---- graine : forces 2025-26, moyennes de ligue, recalage par ligue et par marché (réglage retenu)
import { priorsFrom, leagueStats } from '../netlify/functions/lib/europe/model.mts';
const P0 = { ...E_DEFAULT, K: best.K, tau: best.tau };
const calib: Record<string, any[]> = {};
const edges = [0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
const acc: Record<string, { p: number; y: number }[]> = {};
for (const lg of ['KHL', 'SHL', 'Liiga']) {
  const games = (data[lg] as any[]).filter(g => g.done).sort((a, b) => a.date.localeCompare(b.date));
  for (const d of [...new Set(games.map(g => g.date))]) {
    const past = games.filter(g => g.date < d); if (past.length < 40) continue;
    const R = teamRates(past, null, P0);
    for (const g of games.filter(x => x.date === d)) { const mk = predict(R, g.dom, g.ext, P0); if (!mk) continue;
      for (const m of marketsList(g.dom, g.ext, mk)) { const y = gradeMarket(m.code, g); if (y == null || m.p <= 0.5) continue; (acc[`${lg}|${m.code}`] ||= []).push({ p: m.p, y }); } }
  }
}
for (const [k, xs] of Object.entries(acc)) calib[k] = edges.slice(0, -1).map((lo, i) => { const b = xs.filter(x => x.p >= lo && x.p < edges[i + 1]); return { lo, hi: edges[i + 1], n: b.length, prevu: b.length ? +(b.reduce((t, x) => t + x.p, 0) / b.length).toFixed(3) : null, reel: b.length ? +(b.reduce((t, x) => t + x.y, 0) / b.length).toFixed(3) : null }; }).filter(b => b.n);
const seed = { params: P0, calib, priors: Object.fromEntries(['KHL', 'SHL', 'Liiga'].map(lg => [lg, priorsFrom((data[lg] as any[]).filter(g => g.done))])),
  ligues: Object.fromEntries(['KHL', 'SHL', 'Liiga'].map(lg => [lg, leagueStats((data[lg] as any[]).filter(g => g.done))])) };
fs.writeFileSync('netlify/functions/lib/europe/seed.json', JSON.stringify(seed));
console.log('graine écrite', JSON.stringify(seed.ligues));
