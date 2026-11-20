// Rejeu « au jour le jour » : chaque match est prédit avec les seuls matchs joués avant lui (pas de triche).
// Sert à caler les réglages de départ du modèle NBA (moyennes, dispersions, écarts-types, parts par quart-temps).
import fs from 'node:fs';
import path from 'node:path';
import { teamRows, teamRatings, teamModel, playerAggs, projectPlayer, normalizeMinutes, pAtLeast, NBA_DEFAULT, STATS, LADDER, missingFor, type NbaParams } from '../netlify/functions/lib/nba/model.mts';

const dir = process.argv[2];
const P: NbaParams = JSON.parse(JSON.stringify(NBA_DEFAULT));
if (process.argv[3]) Object.assign(P, JSON.parse(process.argv[3]));
const sets: [string, string][] = [['boxes_last.json', 'avg_2025.json'], ['boxes_cur.json', 'avg_2026.json']];
const rowsP: any[] = [], rowsT: any[] = [];
for (const [bf, af] of sets) {
  const boxes = Object.values(JSON.parse(fs.readFileSync(path.join(dir, bf), 'utf8'))) as any[];
  const prior = JSON.parse(fs.readFileSync(path.join(dir, af), 'utf8'));
  const dates = [...new Set(boxes.map(b => b.date))].sort();
  for (const d of dates) {
    const past = boxes.filter(b => b.date < d);
    if (past.length < 60) continue;
    const T = teamRatings(teamRows(past));
    const PA = playerAggs(past);
    const lastPlayed: Record<string, string> = {};
    for (const b of past) for (const t of [b.ext, b.dom]) lastPlayed[t] = b.date > (lastPlayed[t] || '') ? b.date : lastPlayed[t];
    for (const b of boxes.filter(x => x.date === d)) {
      const played = new Set(b.joueurs.map((r: any) => r[0]));
      const missing = (team: string) => missingFor(PA, past, team, id => !played.has(id));
      const mE = missing(b.ext), mH = missing(b.dom);
      const b2b = (t: string) => +((lastPlayed[t] || '') === new Date(Date.parse(d + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10));
      const tm = teamModel(T, b.dom, b.ext, P, { b2b_dom: b2b(b.dom), b2b_ext: b2b(b.ext), inj_dom: mH.imp, inj_ext: mE.imp });
      if (!tm) continue;
      const margin = tm.pts_dom - tm.pts_ext, total = tm.pts_dom + tm.pts_ext;
      rowsT.push({ d, margin, total, y_m: b.score_dom - b.score_ext, y_t: b.score_dom + b.score_ext, prol: b.prol, qd: b.qt_dom, qe: b.qt_ext, b2b_d: b2b(b.dom), b2b_e: b2b(b.ext), inj_d: mH.imp, inj_e: mE.imp });
      const ctxOf = (r: any) => { const [id, team, , , , , , , , , , , , , , , st] = r; const home = team === b.dom, opp = home ? b.ext : b.dom, ms = home ? mH : mE; const To = T.teams[team], Tp = T.teams[opp];
        return { pace_ratio: tm.pace / To.pace, def_ratio: Tp.drtg / T.L, usage_boost: Math.min(1.15, 1 + 0.5 * ms.u), reb_boost: Math.min(1.1, 1 + 0.3 * ms.rb), min_boost: 0, starter_now: !!st, margin_abs: Math.abs(margin) }; };
      const NM: Record<string, number> = {};
      for (const team of [b.ext, b.dom]) {
        const raw = b.joueurs.filter((r: any) => r[1] === team).map((r: any) => ({ id: r[0], min: PA[r[0]] && PA[r[0]].gp >= 1 ? projectPlayer(PA[r[0]], prior[r[0]] || null, ctxOf(r), P).min : 8 }));
        Object.assign(NM, normalizeMinutes(raw, 240 + 25 * (b.prol || 0) * 0));
      }
      for (const r of b.joueurs) {
        const [id, team, min, pts, , , p3m, , , , reb, , ast, , , , st] = r;
        const a = PA[id]; if (!a || a.gp < 3) continue;
        const pr = projectPlayer(a, prior[id] || null, { ...ctxOf(r), min_override: NM[id] }, P);
        rowsP.push({ d, id, mu: pr.mu, min_exp: pr.min, min, y: { pts, reb, ast, p3: p3m, pra: pts + reb + ast } });
      }
    }
  }
}
console.log('lignes joueurs', rowsP.length, 'matchs', rowsT.length);
console.log('minutes prévues', (rowsP.reduce((t, r) => t + r.min_exp, 0) / rowsP.length).toFixed(2), 'réelles', (rowsP.reduce((t, r) => t + r.min, 0) / rowsP.length).toFixed(2), 'pts/min prévus', (rowsP.reduce((t, r) => t + r.mu.pts, 0) / rowsP.reduce((t, r) => t + r.min_exp, 0)).toFixed(3), 'réels', (rowsP.reduce((t, r) => t + r.y.pts, 0) / rowsP.reduce((t, r) => t + r.min, 0)).toFixed(3));
// ---- joueurs : biais moyen, variance (moments), calibration des seuils
const fit: any = { sc: {}, vc: {}, vd: {} };
for (const s of STATS) {
  const xs = rowsP.filter(r => r.mu[s] > 0.2);
  const sc = xs.reduce((t, r) => t + r.y[s], 0) / xs.reduce((t, r) => t + r.mu[s], 0);
  // variance résiduelle ~ c·μ + d·μ² (moindres carrés sur (y - sc·μ)²)
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (const r of xs) { const m = sc * r.mu[s], e2 = (r.y[s] - m) ** 2; a11 += m * m; a12 += m ** 3; a22 += m ** 4; b1 += m * e2; b2 += m * m * e2; }
  const det = a11 * a22 - a12 * a12, c = (b1 * a22 - b2 * a12) / det, dd = (a11 * b2 - a12 * b1) / det;
  fit.sc[s] = +sc.toFixed(3); fit.vc[s] = +Math.max(0.5, c).toFixed(3); fit.vd[s] = +Math.max(0.005, dd).toFixed(4);
}
console.log('réglages joueurs', JSON.stringify(fit));
const P2 = { ...P, ...fit };
for (const s of STATS) {
  const bins: any = {};
  for (const r of rowsP) for (const k of LADDER[s]) { const p = pAtLeast(s, r.mu[s], k, P2); if (p < 0.05 || p > 0.97) continue; const bi = Math.min(9, Math.floor(p * 10)); (bins[bi] ||= [0, 0, 0]); bins[bi][0]++; bins[bi][1] += p; bins[bi][2] += +(r.y[s] >= k); }
  console.log(s, Object.entries(bins).map(([b, v]: any) => `${b}0%:${(v[1] / v[0] * 100).toFixed(0)}/${(v[2] / v[0] * 100).toFixed(0)} n${v[0]}`).join(' '));
}
// ---- équipes
const mT = rowsT.length, me = rowsT.reduce((t, r) => t + (r.y_m - r.margin), 0) / mT;
const sdM = Math.sqrt(rowsT.reduce((t, r) => t + (r.y_m - r.margin) ** 2, 0) / mT);
const regT = rowsT.map(r => ({ ...r, yt: r.y_t - (r.prol ? 0 : 0) }));
const te = regT.reduce((t, r) => t + (r.yt - r.total), 0) / mT, sdT = Math.sqrt(regT.reduce((t, r) => t + (r.yt - r.total - te) ** 2, 0) / mT);
const acc = rowsT.filter(r => (r.margin > 0) === (r.y_m > 0)).length / mT;
console.log(`écart : biais ${me.toFixed(2)} (domicile sous-estimé si >0), écart-type ${sdM.toFixed(2)} ; total : biais ${te.toFixed(2)}, écart-type ${sdT.toFixed(2)} ; bon vainqueur ${(acc * 100).toFixed(1)} %`);
const q = [0, 1, 2, 3].map(i => rowsT.reduce((t, r) => t + (r.qd[i] || 0) + (r.qe[i] || 0), 0)); const qT = q.reduce((a, b) => a + b);
console.log('parts quarts', q.map(x => (x / qT).toFixed(4)).join(' '));
const sdQ = Math.sqrt(rowsT.reduce((t, r) => t + [0, 1, 2, 3].reduce((u, i) => u + ((r.qd[i] - r.qe[i]) - r.margin / 4) ** 2, 0), 0) / (4 * mT));
const sdH = Math.sqrt(rowsT.reduce((t, r) => t + (((r.qd[0] + r.qd[1]) - (r.qe[0] + r.qe[1])) - r.margin / 2) ** 2, 0) / mT);
console.log(`écart-type quart ${sdQ.toFixed(2)}, mi-temps ${sdH.toFixed(2)}`);
// calibration vainqueur
const bins: any = {};
for (const r of rowsT) { const p = 1 / (1 + Math.exp(-1.7 * (r.margin + me) / sdM)); const b = Math.floor(Math.max(p, 1 - p) * 10); (bins[b] ||= [0, 0, 0]); bins[b][0]++; bins[b][1] += Math.max(p, 1 - p); bins[b][2] += +((r.margin + me > 0) === (r.y_m > 0)); }
console.log('vainqueur', Object.entries(bins).map(([b, v]: any) => `${b}0%:${(v[1] / v[0] * 100).toFixed(0)}/${(v[2] / v[0] * 100).toFixed(0)} n${v[0]}`).join(' '));
fs.writeFileSync(path.join(dir, 'bt_rows.json'), JSON.stringify({ rowsT }));
