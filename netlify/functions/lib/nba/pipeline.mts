// Pipeline NBA : même fonctionnement que le site NHL (MISE À JOUR / PRÉ-MATCH, notation, apprentissage, sélection du soir).
// Sources : ESPN (scores, boîtes de score, blessures, cotes DraftKings), nba.com (cinq majeurs), covers.com (public, leaders).
import { kv } from '../store.mts';
import { etDate, parisStamp, parisHM, addDays, daysBetween, r3, clamp, pool, nameMatch, norm, resetCache } from '../util.mts';
import * as E from './espn.mts';
import * as M from './model.mts';
import { fetchCovers, fetchTopBettors } from '../covers.mts';
import { fetchOlbg } from '../olbg.mts';
import { learnNba } from './learn.mts';
import { buildSelection, bilanSelection, parisSuivis } from './selection.mts';
import seed from './seed.json' with { type: 'json' };

const MODE_LABEL = { update: 'MISE À JOUR', prematch: 'PRÉ-MATCH' } as const;
export const SEASON_START = '2026-10-01';
const emptyDb = () => ({ boxes: {} as Record<string, any>, predictions: [] as any[], odds_open: {} as Record<string, any>, odds_log: [] as any[], injuries_log: [] as any[], results: [] as any[],
  signals: [] as any[], journal: [] as any[], runs: [] as any[], players_log: [] as any[] });

export async function runNba(mode: 'update' | 'prematch', opts: { date?: string; force?: boolean; trigger?: string } = {}) {
  const t0 = Date.now();
  const store = kv('nba');
  const lock = await store.getJSON('lock');
  if (lock && Date.now() - lock.t < 120000 && !opts.force) return { ok: false, busy: true, message: 'Une analyse est déjà en cours, réessaie dans une minute.' };
  await store.setJSON('lock', { t: Date.now(), mode });
  try {
    resetCache();
    const stored = await store.getJSON('db');
    const db: any = Object.assign(emptyDb(), stored || { boxes: (seed as any).boxes });
    let params: M.NbaParams = { ...JSON.parse(JSON.stringify(M.NBA_DEFAULT)), ...((await store.getJSON('params')) || {}) };
    const today = opts.date || etDate(), yday = addDays(today, -1);
    const consulted = parisStamp();
    const log: string[] = [];

    // 1. Boîtes de score manquantes (3 derniers jours) puis notation des paris en attente
    const added = await catchUp(db, today);
    if (added) log.push(`${added} boîte(s) de score ajoutée(s)`);
    const newly = grade(db, today);
    log.push(`${newly} pari(s) noté(s)`);

    // 2. Apprentissage
    const boxes = Object.values(db.boxes).filter((b: any) => b.date >= SEASON_START) as any[];
    const out = learnNba(db, params, boxes, today);
    params = out.params;
    db.journal = db.journal.filter((j: any) => j.date !== today).concat([out.entry]).slice(-120);
    await store.setJSON('params', params);

    // 3. Équipes, résultats de la veille, après-match
    const TR0 = M.teamRows(boxes);
    const T = M.teamRatings(TR0, 10, { ...M.LUCK, w: params.lw ?? 1 });
    const T0 = M.teamRatings(TR0, 10, { ...M.LUCK, w: 0 });   // sans correction de chance : sert à apprendre combien en garder
    (T as any).sans_chance = T0;
    const names = namesOf(boxes);
    const teams = teamTable(boxes, T, today);
    const results = resultsOf(db, yday, names);
    db.results = db.results.filter((r: any) => r.date !== yday).concat(results).slice(-3000);

    // 4. Soirée
    const ev = await buildEvening(db, params, boxes, T, names, today, consulted, mode);
    log.push(`${ev.games.length} match(s) ce soir, ${ev.players.length} joueur(s) suivi(s)`);

    db.runs = db.runs.concat([{ mode, soiree: today, quand: consulted, declencheur: opts.trigger || 'manuel', duree_s: r3((Date.now() - t0) / 1000, 1) }]).slice(-300);
    prune(db, today);
    await store.setJSON('db', db);
    const payload = {
      meta: { ligue: 'NBA', mode: MODE_LABEL[mode], soiree: today, veille: yday, genere: consulted, declencheur: opts.trigger || 'manuel',
        sources: {
          'ESPN – API publique (scores, stats, calendrier, blessures)': consulted,
          'nba.com – cinq majeurs (attendus / confirmés)': ev.lineupInfo,
          'ESPN – cotes du partenaire de paris': ev.oddsInfo,
          'covers.com – public et leaders (à vérifier)': ev.coversInfo,
          'olbg.com – tipsters (à vérifier)': ev.olbgInfo,
        },
        note_sources: "nba.com refuse les programmes automatiques (« Access Denied ») sauf le fichier des cinq majeurs : stats, scores et blessures viennent d'ESPN, diffuseur officiel de la NBA.",
        conflits: ev.conflits },
      selection: ev.selection, games: ev.games, players: ev.players, teams, injuries: ev.injuries, lineups: ev.lineups, results,
      apres: apresMatch(db, yday, names), paris_suivis: parisSuivis(db), reliability: reliability(db),
      learning: { params, defaults: M.NBA_DEFAULT, journal: db.journal.slice(-30).reverse(), signaux: signalBilan(db) },
      log,
    };
    await store.setJSON('latest', payload);
    return { ok: true, mode, soiree: today, duree_s: r3((Date.now() - t0) / 1000, 1), log };
  } finally {
    await store.del('lock');
  }
}

// ------------------------------------------------------------------ données
async function catchUp(db: any, today: string) {
  const days = [1, 2, 3].map(n => addDays(today, -n));
  const games = (await pool(days, 3, d => E.scoreboard(d))).flat().filter(g => g.termine && !db.boxes[g.id]);
  const boxes = await pool(games, 6, g => E.boxscore(g.id, g.date));
  let n = 0;
  for (const b of boxes) if (b) { db.boxes[b.id] = b; n++; }
  return n;
}
function namesOf(boxes: any[]) {
  const n: Record<string, [string, string]> = {};
  for (const b of boxes) Object.assign(n, b.noms || {});
  return n;
}

// ------------------------------------------------------------------ notation : chaque pari est une liste de « jambes »
export function legResult(l: any, b: any): number | null {
  if (!b) return null;
  const dom = b.dom, ext = b.ext, sd = b.score_dom, se = b.score_ext;
  const teamPts = (t: string) => t === dom ? sd : se, oppPts = (t: string) => t === dom ? se : sd;
  const seg = (t: string, s: string) => { const q = t === dom ? b.qt_dom : b.qt_ext, o = t === dom ? b.qt_ext : b.qt_dom; const idx = s === 'H1' ? [0, 1] : s === 'H2' ? [2, 3] : [+s.slice(1) - 1]; return [idx.reduce((x, i) => x + (q[i] || 0), 0), idx.reduce((x, i) => x + (o[i] || 0), 0)]; };
  switch (l.kind) {
    case 'win': return +(teamPts(l.team) > oppPts(l.team));
    case 'spread': { const d = teamPts(l.team) - oppPts(l.team) + l.line; return d === 0 ? null : +(d > 0); }
    case 'over': case 'under': { const t = sd + se; return t === l.line ? null : +((l.kind === 'over') === (t > l.line)); }
    case 'seg': { const [a, o] = seg(l.team, l.seg); return +(a > o); }
    case 'seg_over': case 'seg_under': { const [a, o] = seg(dom, l.seg); const t = a + o; return t === l.line ? null : +((l.kind === 'seg_over') === (t > l.line)); }
    case 'stat': case 'dd': case 'td': {
      const r = (b.joueurs || []).find((x: any) => x[0] === String(l.player_id));
      if (!r) return null;   // n'a pas joué : pari annulé (N/J)
      const v = { pts: r[3], reb: r[10], ast: r[12], p3: r[6], pra: r[3] + r[10] + r[12] } as any;
      if (l.kind === 'stat') return +(v[l.stat] >= l.k);
      const c = [v.pts, v.reb, v.ast].filter(x => x >= 10).length;
      return +(c >= (l.kind === 'dd' ? 2 : 3));
    }
  }
  return null;
}
function grade(db: any, today: string) {
  let n = 0;
  for (const p of db.predictions) {
    if (p.resultat != null || p.date >= today) continue;
    const legs = p.legs || [];
    if (!legs.length) continue;
    const bx = legs.map((l: any) => db.boxes[l.game_id]);
    if (bx.some((b: any) => !b)) { if (daysBetween(p.date, today) > 4) { p.resultat = 'N/J'; n++; } continue; }
    const res = legs.map((l: any, i: number) => legResult(l, bx[i]));
    p.legs_res = res;
    if (p.type === 'Projection joueur') {   // ligne d'apprentissage : on garde les valeurs réelles
      const r = bx[0].joueurs.find((x: any) => x[0] === String(p.player_id));
      p.resultat = r ? 1 : 'N/J';
      if (r) p.y = { pts: r[3], reb: r[10], ast: r[12], p3: r[6], pra: r[3] + r[10] + r[12], min: r[2] };
    } else if (p.type === 'Vainqueur') {
      const b = bx[0];
      p.resultat = res[0]; p.y_m = b.score_dom - b.score_ext; p.y_t = b.score_dom + b.score_ext; p.y_qd = b.qt_dom; p.y_qe = b.qt_ext; p.prol = b.prol;
    } else {
      // jambe non jouée (joueur absent) : on la retire du combiné comme un bookmaker ; tout annulé = N/J
      const kept = res.filter((x: any) => x != null);
      p.resultat = kept.length ? +kept.every((x: any) => x === 1) : 'N/J';
    }
    n++;
  }
  // signaux extérieurs (public, leaders Covers, mouvement de ligne)
  for (const s of db.signals || []) {
    if (s.res != null || s.date >= today) continue;
    const b = db.boxes[s.game_id]; if (!b) continue;
    s.res = { vainqueur: b.score_dom > b.score_ext ? s.dom : s.ext, total: b.score_dom + b.score_ext };
  }
  return n;
}

// ------------------------------------------------------------------ équipes
function teamTable(boxes: any[], T: ReturnType<typeof M.teamRatings>, today: string) {
  const rows = M.teamRows(boxes);
  const by: Record<string, M.TeamRow[]> = {};
  for (const r of rows) (by[r.team] ||= []).push(r);
  const agg: Record<string, any> = {};
  for (const b of boxes) for (const t of [b.ext, b.dom]) { const e = b.equipes?.[t], o = b.equipes?.[t === b.dom ? b.ext : b.dom]; if (!e || !o) continue;
    const a = agg[t] ||= { n: 0, fga: 0, fgm: 0, p3a: 0, p3m: 0, fta: 0, ftm: 0, reb: 0, stl: 0, blk: 0, ast: 0, tov: 0, ofga: 0, ofgm: 0, op3a: 0, op3m: 0, oreb: 0 };
    a.n++; for (const k of ['fga', 'fgm', 'p3a', 'p3m', 'fta', 'ftm', 'reb', 'stl', 'blk', 'ast', 'tov']) a[k] += e[k];
    a.ofga += o.fga; a.ofgm += o.fgm; a.op3a += o.p3a; a.op3m += o.p3m; a.oreb += o.reb; }
  const list = Object.keys(E.TEAM_NAMES).map(t => {
    const rs = by[t] || [], a = agg[t], R = T.teams[t];
    const w = rs.filter(r => r.pts > r.opp_pts).length, l = rs.length - w;
    const hm = rs.filter(r => r.home), aw = rs.filter(r => !r.home);
    const rec = (xs: M.TeamRow[]) => `${xs.filter(r => r.pts > r.opp_pts).length}-${xs.filter(r => r.pts < r.opp_pts).length}`;
    const last10 = rs.slice(-10).map(r => r.pts > r.opp_pts ? 'V' : 'D');
    let streak = ''; if (rs.length) { const last = rs[rs.length - 1].pts > rs[rs.length - 1].opp_pts; let k = 0; for (let i = rs.length - 1; i >= 0 && (rs[i].pts > rs[i].opp_pts) === last; i--) k++; streak = `${k} ${last ? 'victoire' : 'défaite'}${k > 1 ? 's' : ''}`; }
    const lastDate = rs.length ? rs[rs.length - 1].date : null;
    return { equipe: t, nom: E.TEAM_NAMES[t], conference: E.CONF[t][0], division: E.CONF[t][1], mj: rs.length, v: w, d: l, pct: rs.length ? r3(w / rs.length) : null,
      dom: rec(hm), ext: rec(aw), forme10: last10, serie: streak, ppg: R ? r3(R.ppg, 1) : null, papg: R ? r3(R.papg, 1) : null, ecart: R ? r3(R.ppg - R.papg, 1) : null,
      ortg: R ? r3(R.o_raw, 1) : null, drtg: R ? r3(R.d_raw, 1) : null, net: R ? r3(R.o_raw - R.d_raw, 1) : null, pace: R ? r3(R.pace_raw, 1) : null,
      fg_pct: a ? r3(a.fgm / a.fga * 100, 1) : null, p3_pct: a ? r3(a.p3m / a.p3a * 100, 1) : null, p3a: a ? r3(a.p3a / a.n, 1) : null, ft_pct: a ? r3(a.ftm / a.fta * 100, 1) : null, fta: a ? r3(a.fta / a.n, 1) : null,
      reb: a ? r3(a.reb / a.n, 1) : null, stl: a ? r3(a.stl / a.n, 1) : null, blk: a ? r3(a.blk / a.n, 1) : null, ast: a ? r3(a.ast / a.n, 1) : null,
      opp_fg_pct: a ? r3(a.ofgm / a.ofga * 100, 1) : null, opp_p3_pct: a ? r3(a.op3m / a.op3a * 100, 1) : null, chance: R?.chance ? r3(R.chance.net_pts, 1) : null, net_corrige: R?.chance?.net_adj != null ? r3(R.chance.net_adj, 1) : null, repos: lastDate ? daysBetween(lastDate, today) - 1 : null, ats: 'non disponible', ou: 'non disponible' };
  });
  // rangs de conférence et de division (pourcentage de victoires)
  for (const key of ['conference', 'division'] as const) {
    const groups: Record<string, any[]> = {};
    for (const t of list) (groups[t[key]] ||= []).push(t);
    for (const g of Object.values(groups)) g.sort((x, y) => (y.pct ?? 0) - (x.pct ?? 0) || (y.ecart ?? 0) - (x.ecart ?? 0)).forEach((t, i) => { t[`rang_${key}`] = i + 1; });
  }
  for (const t of list) t.zone = t.rang_conference <= 6 ? 'Qualifié direct' : t.rang_conference <= 10 ? 'Play-in' : 'Hors play-in';
  return list;
}

// ------------------------------------------------------------------ résultats de la veille
function resultsOf(db: any, day: string, names: Record<string, [string, string]>) {
  return Object.values(db.boxes).filter((b: any) => b.date === day).map((b: any) => {
    const faits: string[] = [];
    const top: Record<string, any> = {};
    for (const r of b.joueurs) {
      const [id, team, , pts, , , p3, , , , reb, , ast, stl, blk] = r;
      const n = names[id]?.[0] || id;
      if (!top[team] || pts > top[team].pts) top[team] = { nom: n, pts };
      const c = [pts, reb, ast, stl, blk].filter(x => x >= 10).length;
      if (pts >= 40) faits.push(`${n} (${team}) : ${pts} points`);
      if (c >= 3) faits.push(`Triple-double de ${n} (${team}) : ${pts} pts, ${reb} reb, ${ast} pas`);
      else if (pts >= 20 && reb >= 20) faits.push(`${n} (${team}) : ${pts} pts et ${reb} reb`);
      if (p3 >= 8) faits.push(`${n} (${team}) : ${p3} paniers à 3 points`);
    }
    const w = b.score_dom > b.score_ext ? b.dom : b.ext;
    return { date: day, game_id: b.id, match: `${b.ext} @ ${b.dom}`, vainqueur: w, mode: b.prol ? (b.prol > 1 ? `${b.prol} prolongations` : 'Prolongation') : 'Temps réglementaire',
      score: `${b.ext} ${b.score_ext} – ${b.score_dom} ${b.dom}`, ecart: Math.abs(b.score_dom - b.score_ext), quarts: { ext: b.qt_ext, dom: b.qt_dom }, lieu: b.salle,
      meilleurs: [b.ext, b.dom].map(t => top[t] ? `${top[t].nom} (${t}) ${top[t].pts} pts` : '').filter(Boolean), faits, source: 'ESPN' };
  });
}

// ------------------------------------------------------------------ soirée
const STATUS_FR = (s: string) => {
  const x = (s || '').toLowerCase();
  if (/^out|suspen|inactive/.test(x)) return { niveau: 'Confirmé absent', w: 1, label: 'Absent' };
  if (/doubt/.test(x)) return { niveau: 'Incertain', w: 0.8, label: 'Douteux' };
  if (/question|day-to-day|game.time|gtd/.test(x)) return { niveau: 'Incertain', w: 0.35, label: x.includes('day') ? 'Au jour le jour' : 'Incertain' };
  if (/probable|available/.test(x)) return { niveau: 'Confirmé présent', w: 0, label: 'Probable' };
  return { niveau: 'Incertain', w: 0.3, label: s };
};

async function buildEvening(db: any, params: M.NbaParams, boxes: any[], T: ReturnType<typeof M.teamRatings>, names: Record<string, [string, string]>, today: string, consulted: string, mode: string) {
  const priors = (seed as any).priors as Record<string, any>;
  const sbToday = await E.scoreboard(today);
  const nickNba: Record<string, string> = Object.fromEntries(Object.entries(E.TEAM_NAMES).map(([k, v]) => [k, v]));
  const [games, inj, lu, cov, tb, OL] = await Promise.all([
    Promise.resolve(sbToday), E.injuries(), E.nbaLineups(today),
    fetchCovers(E.PLACE, 'nba').catch(() => ({ ok: false, reason: 'covers.com inaccessible', games: [] as any[] })),
    fetchTopBettors(E.PLACE, 10, 'nba').catch(() => ({ ok: false, reason: '', parieurs: [] as any[], paris: [] as any[], n_classes: 0, seuil_chance: 3 })),
    sbToday.length ? fetchOlbg('nba', sbToday.map(g => ({ ext: g.ext, dom: g.dom })), nickNba).catch(() => ({ ok: false, reason: 'olbg.com inaccessible', games: [] as any[] })) : Promise.resolve({ ok: false, reason: 'aucun match', games: [] as any[] }),
  ]);
  const olbgInfo = OL.ok ? `${consulted} (${OL.games.length} match(s)${OL.reason ? ", " + OL.reason : ""})` : `non disponible (${OL.reason})`;
  const PA = M.playerAggs(boxes);
  const TR = M.teamRows(boxes);
  const ppm: Record<string, number> = {};
  { const ag: Record<string, [number, number]> = {}; for (const r of TR) { const a = ag[r.team] ||= [0, 0]; a[0] += r.poss; a[1] += r.min; } for (const [t, [p, m]] of Object.entries(ag)) ppm[t] = p / m; }
  const conflits: string[] = [];
  const injuries = inj.list.filter(i => i.team).map(i => ({ ...i, ...STATUS_FR(i.statut), consulte: consulted }));
  const injOf = (team: string) => injuries.filter(i => i.team === team);
  const findInj = (team: string, id: string, nom: string) => injOf(team).find(i => (i.id && i.id === id) || nameMatch(nom, i.nom));
  const lastPlayed: Record<string, string[]> = {};
  for (const b of boxes) for (const t of [b.ext, b.dom]) (lastPlayed[t] ||= []).push(b.date);
  for (const t in lastPlayed) lastPlayed[t].sort();
  const rest = (t: string) => { const ds = (lastPlayed[t] || []).filter(d => d < today); const last = ds[ds.length - 1]; return { jours: last ? daysBetween(last, today) - 1 : null, b2b: last === addDays(today, -1), trois4: ds.filter(d => d >= addDays(today, -3)).length >= 2,
    route: (() => { const bs = boxes.filter(b => (b.ext === t || b.dom === t) && b.date < today).sort((x, y) => y.date.localeCompare(x.date)); let k = 0; for (const b of bs) { if (b.ext === t) k++; else break; } return k; })() }; };
  const oddsInfo = games.some(g => g.odds) ? `${games.find(g => g.odds)!.odds!.fournisseur}, consulté ${consulted}` : 'non disponibles';
  const lineupInfo = lu.ok ? `${lu.games.length} match(s), consulté ${consulted}` : 'non disponibles';
  const coversInfo = cov.ok ? `${consulted} (${cov.games.length} match(s))` : `non disponible (${(cov as any).reason || 'aucune donnée'})`;

  const outGames: any[] = [], outPlayers: any[] = [], newPreds: any[] = [];
  for (const g of games) {
    const started = g.etat !== 'pre';
    const m = `${g.ext} @ ${g.dom}`;
    const rH = rest(g.dom), rA = rest(g.ext);
    const LU = lu.games.find((x: any) => x.dom === g.dom && x.ext === g.ext) || null;
    // absents et incertains, avec la valeur perdue (pondérée par la présence récente)
    const outW = (team: string) => (id: string) => { const nom = names[id]?.[0] || ''; const i = findInj(team, id, nom); return !!i && i.w >= 0.8; };
    const mH = M.missingFor(PA, boxes, g.dom, outW(g.dom)), mA = M.missingFor(PA, boxes, g.ext, outW(g.ext));
    const tm = M.teamModel(T, g.dom, g.ext, params, { b2b_dom: +rH.b2b, b2b_ext: +rA.b2b, inj_dom: mH.imp, inj_ext: mA.imp, neutre: g.neutre });
    const T0 = (T as any).sans_chance, tm0 = T0 ? M.teamModel(T0, g.dom, g.ext, params, { b2b_dom: +rH.b2b, b2b_ext: +rA.b2b, inj_dom: mH.imp, inj_ext: mA.imp, neutre: g.neutre }) : null;
    const od = g.odds;
    if (od && !db.odds_open[g.id]) db.odds_open[g.id] = { quand: consulted, spread_dom: od.spread_dom, total: od.total, ml_dom: od.ml_dom, ml_ext: od.ml_ext };
    const bl = M.blend(tm, od, params);
    const margin = bl.margin ?? 0, total = bl.total ?? null;
    let pH = M.pWin(margin, params.sm);
    const nv = od?.ml_dom && od?.ml_ext ? (1 / od.ml_dom) / (1 / od.ml_dom + 1 / od.ml_ext) : null;
    if (started) { const fz = db.predictions.find((p: any) => p.game_id === g.id && p.type === 'Vainqueur'); if (fz) pH = fz.p_dom; }
    const pA = 1 - pH;
    const minGp = Math.min(T.teams[g.dom]?.n || 0, T.teams[g.ext]?.n || 0);
    const keyQ = [...mH.out, ...mA.out].length;
    const incert = injuries.filter(i => (i.team === g.dom || i.team === g.ext) && i.niveau === 'Incertain' && PA[i.id || '']?.min / Math.max(1, PA[i.id || '']?.gp || 1) >= 25).length;
    let score = (minGp >= 8 ? 1 : 0) + (od ? 1 : 0) + (LU ? 1 : 0) + (incert === 0 ? 1 : 0);
    const conf = score >= 4 ? 'Élevée' : score >= 2 ? 'Moyenne' : 'Faible';
    const H = T.teams[g.dom], A = T.teams[g.ext];
    const base: string[] = [];
    if (H && A) {
      base.push(`Attaque/défense (points pour 100 possessions, ramenés vers la moyenne en début de saison) : ${g.dom} ${H.ortg.toFixed(1)}/${H.drtg.toFixed(1)}, ${g.ext} ${A.ortg.toFixed(1)}/${A.drtg.toFixed(1)}.`);
      // « PDO » du basket : chance au tir (3 points des adversaires, 3 points de l'équipe, lancers francs adverses)
      for (const [t, R] of [[g.dom, H], [g.ext, A]] as const) { const c = R.chance; if (!c || Math.abs(c.net_pts) < 2) continue;
        base.push(c.net_pts > 0 ? `${t} a été chanceux au tir : environ +${c.net_pts.toFixed(1)} pt/match (adversaires à ${(100 * (c.op3 ?? 0)).toFixed(1)} % à 3 pts, eux à ${(100 * (c.p3 ?? 0)).toFixed(1)} %). Ça ne dure pas : le modèle en retire une partie.`
          : `${t} a été malchanceux au tir : environ ${c.net_pts.toFixed(1)} pt/match (adversaires à ${(100 * (c.op3 ?? 0)).toFixed(1)} % à 3 pts, eux à ${(100 * (c.p3 ?? 0)).toFixed(1)} %). Le modèle s'attend à un retour à la normale.`); }
      base.push(`Rythme attendu : ${tm!.pace.toFixed(1)} possessions (${g.dom} ${H.pace.toFixed(1)}, ${g.ext} ${A.pace.toFixed(1)}).`);
    }
    if (!g.neutre) base.push(`Avantage domicile : +${(params.home + (['DEN', 'UTA'].includes(g.dom) ? params.alt : 0)).toFixed(1)} pt d'écart${['DEN', 'UTA'].includes(g.dom) ? ' (altitude comprise)' : ''}.`);
    for (const [t, r] of [[g.dom, rH], [g.ext, rA]] as const) {
      if (r.b2b) base.push(`${t} joue le 2e soir de suite (back-to-back) : −${params.b2b.toFixed(1)} pt d'écart.`);
      else if (r.trois4) base.push(`${t} : 3e match en 4 soirs.`);
      if (r.route >= 4) base.push(`${t} : ${r.route}e match de suite à l'extérieur (fin de long déplacement).`);
    }
    for (const [t, ms] of [[g.dom, mH], [g.ext, mA]] as const) if (ms.out.length) base.push(`Absents ${t} : ${ms.out.map(o => names[o.id]?.[0] || o.id).join(', ')} → −${(params.inj * ms.imp * 0.6 + params.inj * ms.imp * 0.4).toFixed(1)} pt d'écart.`);
    const tRecs = (t: string) => { const rs = TR.filter(r => r.team === t).slice(-10); return `${rs.filter(r => r.pts > r.opp_pts).length}-${rs.filter(r => r.pts < r.opp_pts).length}`; };
    base.push(`Forme sur 10 matchs : ${g.dom} ${tRecs(g.dom)}, ${g.ext} ${tRecs(g.ext)}.`);
    const h2h = boxes.filter(b => (b.dom === g.dom && b.ext === g.ext) || (b.dom === g.ext && b.ext === g.dom));
    if (h2h.length) base.push(`Confrontations cette saison : ${h2h.map(b => `${b.ext} ${b.score_ext}-${b.score_dom} ${b.dom}`).join(' ; ')}.`);
    if (od) base.push(`Cotes ${od.fournisseur} : écart ${od.spread_dom != null ? (od.spread_dom > 0 ? '+' : '') + od.spread_dom : '?'} pour ${g.dom}, total ${od.total ?? '?'}. Mon modèle seul : ${tm ? (tm.pts_dom - tm.pts_ext).toFixed(1) : '?'} d'écart, ${tm ? (tm.pts_dom + tm.pts_ext).toFixed(1) : '?'} points. Retenu : ${margin.toFixed(1)} et ${total?.toFixed(1)} (poids des cotes ${Math.round(params.wm * 100)} % / ${Math.round(params.wt * 100)} %).`);
    // marchés
    const pCover = (team: string, line: number) => { const mm = team === g.dom ? margin : -margin; return clamp(1 - M.Phi((-line - mm) / params.sm), 0.02, 0.98); };
    const pOver = (line: number) => total == null ? null : clamp(1 - M.Phi((line - total) / params.st), 0.02, 0.98);
    const segs = ['H1', 'Q1', 'Q2', 'Q3', 'Q4'].map(s => {
      const sh = s === 'H1' ? params.qs[0] + params.qs[1] : params.qs[+s[1] - 1];
      const mg = s === 'H1' ? margin / 2 : margin / 4, sd = s === 'H1' ? params.sh : params.sq;
      const pd = M.pWinSeg(mg, sd), pe = M.pWinSeg(-mg, sd);
      return { seg: s, label: s === 'H1' ? '1re mi-temps' : `${s[1]}${s[1] === '1' ? 'er' : 'e'} quart-temps`, total: total != null ? r3(total * sh, 1) : null, ecart_dom: r3(mg, 1), p_dom: r3(pd), p_ext: r3(pe), p_nul: r3(clamp(1 - pd - pe, 0, 1)) };
    });
    const mk: any = { spread: null, total: null };
    if (od?.spread_dom != null) mk.spread = { line_dom: od.spread_dom, line_ext: -od.spread_dom, p_dom: r3(pCover(g.dom, od.spread_dom)), p_ext: r3(pCover(g.ext, -od.spread_dom)), cote_dom: r3(od.sp_cote_dom, 2), cote_ext: r3(od.sp_cote_ext, 2) };
    if (od?.total != null && total != null) mk.total = { line: od.total, p_over: r3(pOver(od.total)), p_under: r3(1 - pOver(od.total)!), cote_over: r3(od.over_cote, 2), cote_under: r3(od.under_cote, 2) };
    // lecture pro : meilleur écart avec la cote sans marge
    const cv = cov.games.find((c: any) => c.home === g.dom && c.away === g.ext) || null;
    const open = db.odds_open[g.id];
    const notes: string[] = [];
    let verdict = od ? 'Pas d’avantage : passer' : 'Pas de cote : impossible de juger l’avantage', side: string | null = null, mise = 0, pcote: number | null = null, pmarket: string | null = null;
    if (od?.ml_dom && od?.ml_ext && nv != null) {
      const cands = [{ ab: g.dom, p: pH, imp: nv, cote: od.ml_dom, lab: 'vainqueur' }, { ab: g.ext, p: pA, imp: 1 - nv, cote: od.ml_ext, lab: 'vainqueur' }];
      if (mk.spread && od.sp_cote_dom && od.sp_cote_ext) { const iv = (1 / od.sp_cote_dom) / (1 / od.sp_cote_dom + 1 / od.sp_cote_ext); cands.push({ ab: g.dom, p: mk.spread.p_dom, imp: iv, cote: od.sp_cote_dom, lab: `handicap ${od.spread_dom > 0 ? '+' : ''}${od.spread_dom}` }, { ab: g.ext, p: mk.spread.p_ext, imp: 1 - iv, cote: od.sp_cote_ext, lab: `handicap ${-od.spread_dom > 0 ? '+' : ''}${-od.spread_dom}` }); }
      const best = cands.sort((x, y) => (y.p - y.imp) - (x.p - x.imp))[0];
      const edge = best.p - best.imp;
      notes.push(`${best.ab} (${best.lab}) : ${Math.round(best.p * 100)} % selon moi contre ${Math.round(best.imp * 100)} % dans la cote (${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)} pts).`);
      if (cv) { const pub = cv.public_dom >= cv.public_ext ? g.dom : g.ext, pp = Math.max(cv.public_dom, cv.public_ext); if (pp >= 65) notes.push(`${pp} % du public sur ${pub}${pub === best.ab ? ' : pari populaire, la cote est souvent moins généreuse' : ''}.`);
        if (cv.leaders_dom + cv.leaders_ext >= 4) notes.push(`Leaders Covers : ${cv.leaders_dom} sur ${g.dom}, ${cv.leaders_ext} sur ${g.ext}.`); }
      if (open?.spread_dom != null && od.spread_dom != null && open.spread_dom !== od.spread_dom) notes.push(`La ligne a bougé de ${open.spread_dom} à ${od.spread_dom} pour ${g.dom} depuis ${open.quand}.`);
      const k = (best.p * best.cote - 1) / (best.cote - 1);
      if (edge >= params.vthr && conf !== 'Faible') { verdict = 'Jouable'; side = best.ab; pmarket = best.lab; mise = clamp(k / 4, 0, 0.02); pcote = best.cote; }
      else if (edge >= 0.02) verdict = 'Léger avantage : petite mise ou passer';
    }
    const game: any = {
      game_id: g.id, date: today, exterieur: g.ext, domicile: g.dom, nom_ext: E.TEAM_NAMES[g.ext], nom_dom: E.TEAM_NAMES[g.dom], etat: g.etat, statut: g.statut, commence: started,
      debut_paris: parisHM(g.utc), salle: g.salle, ville: g.ville, note: g.note, neutre: g.neutre,
      pts_dom: tm ? r3(margin / 2 + (total ?? 0) / 2, 1) : null, pts_ext: tm ? r3((total ?? 0) / 2 - margin / 2, 1) : null, ecart_dom: r3(margin, 1), total: r3(total, 1),
      pts_modele_dom: tm ? r3(tm.pts_dom, 1) : null, pts_modele_ext: tm ? r3(tm.pts_ext, 1) : null,
      p_dom: r3(pH), p_ext: r3(pA), cote_dom: r3(od?.ml_dom, 2), cote_ext: r3(od?.ml_ext, 2), imp_dom: r3(nv), imp_ext: nv != null ? r3(1 - nv) : null,
      valeur_dom: nv != null && pH - nv >= params.vthr ? 'Valeur potentielle' : null, valeur_ext: nv != null && pA - (1 - nv) >= params.vthr ? 'Valeur potentielle' : null,
      source_cotes: od ? `ESPN (partenaire ${od.fournisseur})` : null, marches: mk, segments: segs, repos: { dom: rH, ext: rA }, confiance: conf, base,
      absents: { dom: mH.out.map(o => ({ nom: names[o.id]?.[0] || o.id, min: r3(o.min, 1) })), ext: mA.out.map(o => ({ nom: names[o.id]?.[0] || o.id, min: r3(o.min, 1) })) },
      cinq: LU ? { dom: LU.joueurs.filter((p: any) => p.team === g.dom), ext: LU.joueurs.filter((p: any) => p.team === g.ext) } : null,
      pro: { verdict, side, marche: pmarket, cote: r3(pcote, 2), mise_pct: r3(mise * 100, 1), notes },
      parieurs: cv ? { public_dom: cv.public_dom, public_ext: cv.public_ext, leaders_dom: cv.leaders_dom, leaders_ext: cv.leaders_ext, over_pct: cv.over_pct, total: cv.total, leaders_over: cv.leaders_over, leaders_under: cv.leaders_under, url: cv.url } : null,
      ouverture: open || null,
    };
    outGames.push(game);

    // ---- joueurs du match
    for (const [team, opp, ms, isHome] of [[g.ext, g.dom, mA, false], [g.dom, g.ext, mH, true]] as const) {
      const To = T.teams[team], Tp = T.teams[opp];
      if (!To || !Tp) continue;
      const roster = Object.values(PA).filter(a => a.team === team && a.games.length && daysBetween(a.games[a.games.length - 1].date, today) <= 21);
      const starters = LU ? LU.joueurs.filter((p: any) => p.team === team) : [];
      const ctxOf = (a: M.PAgg, mo?: number) => {
        const nom = names[a.id]?.[0] || '';
        const st = starters.length ? starters.some((s: any) => nameMatch(nom, s.nom)) : null;
        return { pace_ratio: tm ? tm.pace / To.pace : 1, def_ratio: Tp.drtg / T.L, usage_boost: Math.min(1.15, 1 + 0.5 * ms.u), reb_boost: Math.min(1.1, 1 + 0.3 * ms.rb), min_boost: 0, starter_now: st, margin_abs: Math.abs(margin), min_override: mo };
      };
      const avail = roster.map(a => ({ a, nom: names[a.id]?.[0] || a.id, i: findInj(team, a.id, names[a.id]?.[0] || '') }));
      const raw = avail.filter(x => !x.i || x.i.w < 0.8).map(x => ({ id: x.a.id, full: M.projectPlayer(x.a, priors[x.a.id] || null, ctxOf(x.a), params).min, w: x.i ? 1 - x.i.w : 1 }));
      const fac = 240 / Math.max(1, raw.reduce((t, r) => t + r.full * r.w, 0));
      const NM: Record<string, number> = Object.fromEntries(raw.map(r => [r.id, Math.min(42, r.full * Math.min(fac, 1.35))]));   // projection « s'il joue »
      for (const { a, nom, i } of avail) {
        const out = !!i && i.w >= 0.8;
        const pr = M.projectPlayer(a, priors[a.id] || null, ctxOf(a, out ? 0 : NM[a.id]), params);
        if (!out && pr.min < 8) continue;
        const P: any = {};
        for (const s of M.STATS) { P[s] = {}; for (const k of M.LADDER[s]) P[s][k] = r3(Math.min(0.97, M.calibrate(params.calib?.[`${s}_${k}`] || params.calib?.[s], M.pAtLeast(s, pr.mu[s], k, params)))); }
        const pts10 = P.pts[10], reb10 = P.reb[10], ast10 = P.ast[10];
        const dd = r3(pts10 * reb10 + pts10 * ast10 + reb10 * ast10 - 2 * pts10 * reb10 * ast10);
        const lineOf = (s: M.Stat, thr: number) => { let best: number | null = null; for (const k of M.LADDER[s]) if (P[s][k] >= thr) best = k; return best; };
        const gs = a.games, L10 = gs.slice(-10);
        const av = (xs: any[], k: string) => xs.length ? r3(xs.reduce((t, x) => t + x[k], 0) / xs.length, 1) : null;
        const pri = priors[a.id];
        const streak = (() => { const ln = Math.max(10, (lineOf('pts', 0.6) ?? 10)); let k = 0; for (let j = gs.length - 1; j >= 0 && gs[j].pts >= ln; j--) k++; return k >= 3 ? `${ln}+ points dans ${k} matchs de suite` : null; })();
        const vs = gs.filter(x => x.opp === opp);
        const usage = ppm[team] && a.min ? r3(100 * ((a.fga + 0.44 * a.fta + a.tov) / a.min) / ppm[team], 1) : null;   // part des possessions utilisées quand il est sur le terrain
        const p3reg = pr.p3pct, l3 = pr.l10_p3pct;
        const serie = l3 != null && pr.l10_p3a >= 25 && l3 - p3reg >= 0.08 ? 'flatteuse' : l3 != null && pr.l10_p3a >= 30 && p3reg - l3 >= 0.08 ? 'malchanceux' : null;
        const statut = i ? `${i.label} (${i.blessure})` : 'Disponible';
        const titu = starters.length ? (starters.some((s: any) => nameMatch(nom, s.nom)) ? (starters.find((s: any) => nameMatch(nom, s.nom))?.statut === 'Confirmed' ? 'Titulaire confirmé' : 'Titulaire attendu') : 'Remplaçant') : (pr.wasStarter ? 'Titulaire probable (non publié)' : 'Remplaçant probable');
        const minSd = (() => { const xs = gs.slice(-5).map(x => x.min); if (xs.length < 3) return 10; const m0 = xs.reduce((t, x) => t + x, 0) / xs.length; return Math.sqrt(xs.reduce((t, x) => t + (x - m0) ** 2, 0) / xs.length); })();
        let fiab = 30 + Math.min(25, a.gp * 2.5) + (pri ? 15 : 0) + (starters.length ? 10 : 0) + Math.max(0, 20 - minSd * 3);
        if (i && !out) fiab -= 25;
        fiab = Math.round(clamp(fiab, 5, 100));
        const raisons: string[] = [
          `${pr.min.toFixed(1)} min attendues (5 derniers : ${av(gs.slice(-5), 'min')}, saison : ${r3(a.min / a.gp, 1)}${pri ? `, saison passée : ${r3(pri.min / pri.gp, 1)}` : ''}).`,
          `${r3(pr.mu.pts, 1)} pts, ${r3(pr.mu.reb, 1)} reb, ${r3(pr.mu.ast, 1)} pas attendus. Défense adverse : ${Tp.drtg.toFixed(1)} pts encaissés pour 100 possessions (moyenne ${T.L.toFixed(1)}).`,
        ];
        if (ms.out.length && ms.u > 0.03) raisons.push(`Absences dans son équipe (${ms.out.map(o => names[o.id]?.[0] || o.id).join(', ')}) : +${Math.round((Math.min(1.15, 1 + 0.5 * ms.u) - 1) * 100)} % de ballons.`);
        if (serie === 'flatteuse') raisons.push(`Série flatteuse : ${Math.round(l3! * 100)} % à 3 points sur 10 matchs contre ${Math.round(p3reg * 100)} % de normale. Je retiens sa normale.`);
        if (serie === 'malchanceux') raisons.push(`Malchanceux : ${Math.round(l3! * 100)} % à 3 points sur 10 matchs malgré ${pr.l10_p3a} tirs. Sa normale (${Math.round(p3reg * 100)} %) devrait revenir.`);
        const pl: any = {
          id: a.id, nom, pos: names[a.id]?.[1] || '', equipe: team, adversaire: opp, game_id: g.id, match: m, domicile: isHome, statut, absent: out, incertain: !!i && !out, titulaire: titu,
          min_prevues: r3(pr.min, 1), mu: Object.fromEntries(M.STATS.map(s => [s, r3(pr.mu[s], 1)])), p: P, p_dd: dd, p_30: P.pts[30], p_25: P.pts[25], p_20: P.pts[20],
          ligne_pts: lineOf('pts', 0.7), ligne_reb: lineOf('reb', 0.7), ligne_ast: lineOf('ast', 0.7), ligne_p3: lineOf('p3', 0.7), ligne_pra: lineOf('pra', 0.7),
          mj: a.gp, saison: { min: r3(a.min / a.gp, 1), pts: r3(a.pts / a.gp, 1), reb: r3(a.reb / a.gp, 1), ast: r3(a.ast / a.gp, 1), p3: r3(a.p3m / a.gp, 1), pra: r3((a.pts + a.reb + a.ast) / a.gp, 1), stl: r3(a.stl / a.gp, 1), blk: r3(a.blk / a.gp, 1), tov: r3(a.tov / a.gp, 1),
            fg: a.fga ? r3(100 * a.fgm / a.fga, 1) : null, p3pct: a.p3a ? r3(100 * a.p3m / a.p3a, 1) : null, ft: a.fta ? r3(100 * a.ftm / a.fta, 1) : null },
          l10: { min: av(L10, 'min'), pts: av(L10, 'pts'), reb: av(L10, 'reb'), ast: av(L10, 'ast'), p3: av(L10, 'p3'), pra: L10.length ? r3(L10.reduce((t, x) => t + x.pts + x.reb + x.ast, 0) / L10.length, 1) : null },
          prec: pri ? { pts: r3(pri.pts / pri.gp, 1), reb: r3(pri.reb / pri.gp, 1), ast: r3(pri.ast / pri.gp, 1), min: r3(pri.min / pri.gp, 1) } : null,
          usage, serie, sequence: streak, vs_adv: vs.length ? `${vs.length} MJ : ${r3(vs.reduce((t, x) => t + x.pts, 0) / vs.length, 1)} pts, ${r3(vs.reduce((t, x) => t + x.reb, 0) / vs.length, 1)} reb, ${r3(vs.reduce((t, x) => t + x.ast, 0) / vs.length, 1)} pas` : 'aucun match cette saison',
          p3_reg: r3(p3reg * 100, 1), p3_l10: l3 != null ? r3(l3 * 100, 1) : null, forme: gs.slice(-10).map(x => x.pts), fiabilite: fiab, raisons, commence: started,
        };
        outPlayers.push(pl);
        if (!started && !out && pr.min >= 20) newPreds.push({ date: today, v: 1, type: 'Projection joueur', game_id: g.id, player_id: a.id, selection: nom, equipe: team, pos: pl.pos,
          mu: pl.mu, min_exp: pl.min_prevues, legs: [{ kind: 'stat', stat: 'pts', k: 0, player_id: a.id, game_id: g.id }], resultat: null });
      }
    }
    if (!started) {
      const fav = pH >= pA ? g.dom : g.ext;
      newPreds.push({ date: today, v: 1, type: 'Vainqueur', game_id: g.id, match: m, domicile: g.dom, exterieur: g.ext, selection: fav, prob: r3(Math.max(pH, pA)), p_dom: r3(pH), cote: fav === g.dom ? r3(od?.ml_dom, 2) : r3(od?.ml_ext, 2),
        confiance: conf, legs: [{ kind: 'win', team: fav, game_id: g.id }], mm: tm ? r3(tm.pts_dom - tm.pts_ext, 2) : null, lk: tm && tm0 ? r3((tm.pts_dom - tm.pts_ext) - (tm0.pts_dom - tm0.pts_ext), 2) : null, lw: params.lw ?? 1, mt: tm ? r3(tm.pts_dom + tm.pts_ext - (params.tb ?? 0), 2) : null, hm: tm ? tm.hm : null,
        km: od?.spread_dom != null ? -od.spread_dom : null, kt: od?.total ?? null, nv, resultat: null });
      db.signals = (db.signals || []).filter((x: any) => !(x.game_id === g.id && x.res == null)).concat([{ date: today, game_id: g.id, dom: g.dom, ext: g.ext,
        picks: { modele: pH >= pA ? g.dom : g.ext, public: cv ? (cv.public_dom >= cv.public_ext ? g.dom : g.ext) : null, leaders: cv && cv.leaders_dom !== cv.leaders_ext && cv.leaders_dom + cv.leaders_ext >= 4 ? (cv.leaders_dom > cv.leaders_ext ? g.dom : g.ext) : null, pro: side },
        total: od?.total ?? null, ou: cv?.over_pct != null ? (cv.over_pct >= 50 ? 'over' : 'under') : null, res: null }]);
      if (od) db.odds_log.push({ date: today, match: m, fournisseur: od.fournisseur, ml_ext: r3(od.ml_ext, 2), ml_dom: r3(od.ml_dom, 2), spread_dom: od.spread_dom, total: od.total, heure: consulted });
    }
  }
  // ---- sélection du soir et paris suivis
  const started = new Set(outGames.filter(g => g.commence).map(g => g.game_id));
  const selection = buildSelection(outGames, outPlayers, started, db, params, tb, cov, OL);
  for (const p of selection.preds) newPreds.push({ ...p, date: today, resultat: null });
  delete selection.preds;
  selection.bilan = bilanSelection(db);
  const replaced = new Set(outGames.filter(g => !g.commence).map(g => g.game_id));
  db.predictions = db.predictions.filter((p: any) => !(p.date === today && p.resultat == null && (p.legs || []).some((l: any) => replaced.has(l.game_id)))).concat(newPreds);
  db.injuries_log = db.injuries_log.filter((x: any) => x.date !== today).concat(injuries.filter(i => outGames.some(g => g.domicile === i.team || g.exterieur === i.team)).map(i => ({ date: today, team: i.team, nom: i.nom, statut: i.statut, blessure: i.blessure, consulte: consulted })));
  const lineups = outGames.map(g => ({ match: `${g.exterieur} @ ${g.domicile}`, game_id: g.game_id, statut: g.cinq ? (g.cinq.dom.concat(g.cinq.ext).every((p: any) => p.statut === 'Confirmed') ? 'confirmées' : 'probables (attendues)') : 'non disponibles',
    cinq: g.cinq, absents: g.absents,
    rotation: Object.fromEntries([g.exterieur, g.domicile].map(t => [t, outPlayers.filter(p => p.equipe === t && !p.absent).sort((x, y) => y.min_prevues - x.min_prevues).slice(0, 9).map(p => ({ nom: p.nom, min: p.min_prevues, titulaire: p.titulaire, statut: p.statut }))])) }));
  return { games: outGames, players: outPlayers, injuries, lineups, selection, oddsInfo, lineupInfo, coversInfo, olbgInfo, conflits };
}

// ------------------------------------------------------------------ après-match
function apresMatch(db: any, day: string, names: Record<string, [string, string]>) {
  const rows = db.predictions.filter((p: any) => p.date === day && p.type === 'Sélection points' && (p.resultat === 0 || p.resultat === 1 || p.resultat === 'N/J'));
  const proj = db.predictions.filter((p: any) => p.date === day && p.type === 'Projection joueur' && p.y);
  const games = Object.values(db.boxes).filter((b: any) => b.date === day) as any[];
  const parMatch = games.map(b => {
    const ls = proj.filter((p: any) => p.game_id === b.id).map((p: any) => {
      const sel = rows.find((r: any) => r.legs?.[0]?.player_id === p.player_id);
      const k = sel?.legs?.[0]?.k ?? null;
      const ok = k != null ? p.y.pts >= k : null;
      const blow = Math.abs(b.score_dom - b.score_ext) >= 20;
      const cause = ok ? 'Réussi' : p.y.min < p.min_exp * 0.75 ? (blow ? 'Match plié / écart important' : 'Minutes réduites') : (p.y.pts < p.mu.pts * 0.7 ? 'Mauvaise adresse' : 'Variance normale');
      return { nom: p.selection, equipe: p.equipe, seuil: k, prob: sel?.prob ?? null, res: sel ? (sel.resultat === 'N/J' ? 'N/J' : sel.resultat ? 'Réussi' : 'Raté') : null, min_prevu: p.min_exp, min_reel: p.y.min, pts_prevus: p.mu.pts, pts: p.y.pts, reb: p.y.reb, ast: p.y.ast, cause: sel ? cause : null };
    }).sort((x: any, y: any) => (y.prob ?? 0) - (x.prob ?? 0) || y.pts_prevus - x.pts_prevus);
    const notPlayed = rows.filter((r: any) => r.resultat === 'N/J' && r.legs?.[0]?.game_id === b.id).map((r: any) => ({ nom: r.selection, seuil: r.legs[0].k, prob: r.prob, res: 'N/J', cause: 'Ne joue pas / Repos' }));
    return { match: `${b.ext} @ ${b.dom}`, score: `${b.ext} ${b.score_ext} – ${b.score_dom} ${b.dom}`, joueurs: ls.concat(notPlayed) };
  });
  const g = rows.filter((r: any) => r.resultat === 0 || r.resultat === 1);
  const exp = g.reduce((t: number, r: any) => t + r.prob, 0);
  return { date: day, n: g.length, reussis: g.filter((r: any) => r.resultat === 1).length, attendu: r3(exp, 1), par_match: parMatch };
}

// ------------------------------------------------------------------ fiabilité : annoncé contre réel, par type
function reliability(db: any) {
  const types = [...new Set(db.predictions.filter((p: any) => p.type !== 'Projection joueur').map((p: any) => p.type))] as string[];
  return types.map(t => {
    const g = db.predictions.filter((p: any) => p.type === t && (p.resultat === 0 || p.resultat === 1) && p.prob != null);
    const bins = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01].slice(0, -1).map((lo, i, a) => { const hi = [0.5, 0.6, 0.7, 0.8, 0.9, 1.01][i]; const b = g.filter((p: any) => p.prob >= lo && p.prob < hi); return { lo, hi, n: b.length, prevu: b.length ? r3(b.reduce((s: number, p: any) => s + p.prob, 0) / b.length) : null, reel: b.length ? r3(b.filter((p: any) => p.resultat === 1).length / b.length) : null }; }).filter(b => b.n);
    return { type: t, n: g.length, gagnes: g.filter((p: any) => p.resultat === 1).length, prevu: g.length ? r3(g.reduce((s: number, p: any) => s + p.prob, 0) / g.length) : null, bins };
  }).filter(x => x.n).sort((a, b) => b.n - a.n);
}
function signalBilan(db: any) {
  const S = (db.signals || []).filter((s: any) => s.res);
  return ['modele', 'public', 'leaders', 'pro'].map(k => {
    const xs = S.filter((s: any) => s.picks?.[k]);
    const w = xs.filter((s: any) => s.picks[k] === s.res.vainqueur).length, n = xs.length;
    const z = n ? (w / n - 0.5) / Math.sqrt(0.25 / n) : 0;
    return { signal: { modele: 'Mon modèle', public: 'Public Covers', leaders: 'Leaders Covers', pro: 'Lecture pro' }[k], n, gagnes: w, taux: n ? r3(w / n) : null, z: r3(z, 2), prouve: n >= 30 && z >= 1.96 };
  });
}
function prune(db: any, today: string) {
  db.predictions = db.predictions.filter((p: any) => p.type !== 'Projection joueur' || daysBetween(p.date, today) <= 150);
  db.odds_log = db.odds_log.filter((x: any) => daysBetween(x.date, today) <= 200);
  db.injuries_log = db.injuries_log.filter((x: any) => daysBetween(x.date, today) <= 120);
  db.signals = db.signals.filter((x: any) => daysBetween(x.date, today) <= 200);
  for (const k of Object.keys(db.odds_open)) if (!db.boxes[k] && Object.keys(db.odds_open).length > 400) delete db.odds_open[k];
}
