// Pipeline complet : résultats + évaluation + apprentissage (MISE À JOUR) et prédictions du soir (PRÉ-MATCH).
// Sources : nhl.com uniquement (API officielle, cotes partenaires affichées par nhl.com, article des compositions).
import { poisson, W, S, get, safe, pool, nm, r3, clamp, norm, nameMatch, etDate, parisStamp, parisHM, addDays, daysBetween, seasons, americanToDecimal, resetCache } from './util.mts';
import { fetchLineups, isInLineup, lineSlot, type GameLineup } from './lineups.mts';
import { gameProbs, teamStrength, bttsProbs, defaultParams, pNB, pAtLeastK, calibrate, marketLambdas, PRIORS, type Params, type GameFeat } from './model.mts';
import { learn } from './learn.mts';
import { kv, emptyDb } from './store.mts';
import { fetchCovers, fetchTopBettors } from './covers.mts';
import { fetchOlbg, legLabel } from './olbg.mts';
import seedDb from './seed-db.json' with { type: 'json' };
import { gameXg } from './xg.mts';
import xgSeed from './xg-seed.json' with { type: 'json' };

const GAME_TYPES = [2, 3];
const FINAL = ['OFF', 'FINAL'];
const NOT_STARTED = ['FUT', 'PRE'];
const MODE_LABEL = { update: 'MISE À JOUR', prematch: 'PRÉ-MATCH' } as const;

export async function runPipeline(mode: 'update' | 'prematch', opts: { date?: string; force?: boolean; trigger?: string } = {}) {
  const t0 = Date.now();
  const store = kv();
  const lock = await store.getJSON('lock');
  if (lock && Date.now() - lock.t < 120000 && !opts.force) return { ok: false, busy: true, message: 'Une analyse est déjà en cours, réessaie dans une minute.' };
  await store.setJSON('lock', { t: Date.now(), mode });
  try {
    resetCache();
    let stored = await store.getJSON('db');
    if (!stored) stored = JSON.parse(JSON.stringify(seedDb));  // premier lancement : reprise de l'historique local
    const db = Object.assign(emptyDb(), stored || {});
    let params: Params = Object.assign(defaultParams(), (await store.getJSON('params')) || {});
    // Moteur v2 (équipes jugées aussi sur les tirs, cotes du total, modèle « sur la glace ») : l'échelle des buts apprise
    // sur l'ancien moteur ne s'applique plus telle quelle ; elle sera réapprise sur les seuls résultats du nouveau moteur.
    if ((params as any).model_v !== 2) { params.xg = 1; (params as any).model_v = 2; (params as any).v2_depuis = opts.date || etDate(); }
    const today = opts.date || etDate();
    const yday = addDays(today, -1);
    const ctx = await buildContext(today);
    const log: string[] = [];

    // 1. Résultats de la veille + évaluation de toutes les prédictions en attente
    const { results, newlyGraded } = await gradeAndResults(ctx, db, yday, params);
    log.push(`${results.length} résultat(s) la veille, ${newlyGraded} prédiction(s) évaluée(s)`);

    // 1b. Rétro-analyse des soirées déjà évaluées avant l'existence de l'après-match
    if (!db.postmatch) await backfillPostMatch(db, params);

    // 2. Apprentissage (seulement si de nouvelles prédictions ont été évaluées)
    let journalEntry = db.journal.find((j: any) => j.date === today) || null;
    {  // à chaque passage : peu coûteux, et les réglages restent alignés sur tout l'historique
      const out = learn(db, params, today);
      params = out.params;
      const prevChanges = journalEntry?.changes || [];
      journalEntry = { ...out.entry, changes: [...prevChanges, ...out.entry.changes], misses: missesOf(db, yday) };
      db.journal = db.journal.filter((j: any) => j.date !== today).concat([journalEntry]).slice(-120);
      await store.setJSON('params', params);
    }

    // 2b. Buts attendus (xG) des matchs joués : position et type de chaque tir (play-by-play), calcul incrémental
    const nXg = await updateXg(ctx, db);
    if (nXg) log.push(`${nXg} match(s) ajouté(s) aux buts attendus (xG)`);

    // 3. Équipes
    const teams = ctx.abbrs.map(ab => teamSnapshot(ctx, ab));
    db.teams = db.teams.filter((t: any) => t.date !== today).concat(teams.map(t => ({ ...t, date: today, source: 'nhl.com', consulte: ctx.consulted })));
    db.teams = db.teams.filter((t: any) => daysBetween(t.date, today) <= 120);

    // 4. Soirée
    const evening = await buildEvening(ctx, db, params, mode);
    log.push(`${evening.games.length} match(s) ce soir, ${evening.players.length} joueur(s) suivi(s)`);

    db.signals = (db.signals || []).filter((x: any) => daysBetween(x.date, today) <= 200);
    db.runs = db.runs.concat([{ mode, soiree: today, quand: ctx.consulted, declencheur: opts.trigger || 'manuel', duree_s: r3((Date.now() - t0) / 1000, 1) }]).slice(-300);
    prune(db, today);
    await store.setJSON('db', db);

    const payload = {
      meta: {
        mode: MODE_LABEL[mode], soiree: today, veille: yday, genere: ctx.consulted, saison: ctx.cur, declencheur: opts.trigger || 'manuel',
        sources: {
          'nhl.com – API officielle (scores, stats, calendrier)': ctx.consulted,
          'nhl.com – article des compositions projetées': evening.lineupInfo,
          'nhl.com – cotes du partenaire de paris': evening.oddsInfo,
          'covers.com – public et leaders (à vérifier)': evening.coversInfo,
          'olbg.com – tipsters (à vérifier)': evening.olbgInfo,
        },
        conflits: [] as string[],
      },
      selection: evening.selection, games: evening.games, players: evening.players, teams, injuries: evening.injuries, results,
      reliability: reliability(db),
      signaux: signalBilan(db),
      paris_suivis: parisSuivis(db),
      learning: { params, priors: PRIORS, journal: db.journal.slice(-30).reverse() },
      apres: apresMatch(db, yday),
      history: db.predictions.filter((p: any) => p.resultat === 0 || p.resultat === 1 || p.resultat === 'N/J').slice(-400).map(({ feat, ...rest }: any) => rest),
      log,
    };
    await store.setJSON('latest', payload);
    return { ok: true, mode, soiree: today, duree_s: r3((Date.now() - t0) / 1000, 1), log };
  } finally {
    await store.del('lock');
  }
}

// ------------------------------------------------------------------ contexte
/** L'API stats de la LNH ne renvoie plus que 100 lignes par requête (même avec limit=-1) : on lit toutes les pages,
 * triées par joueur pour qu'aucune ligne ne saute d'une page à l'autre. */
async function pages(base: string): Promise<{ data: any[] }> {
  const srt = 'sort=' + encodeURIComponent('[{"property":"playerId","direction":"ASC"}]');
  const url = (st: number) => `${base}&limit=100&start=${st}&${srt}`;
  const first = await safe(url(0), { data: [] as any[], total: 0 });
  const starts: number[] = [];
  for (let st = 100; st < (first.total || 0); st += 100) starts.push(st);
  const more = await pool(starts, 6, async st => (await safe(url(st), { data: [] as any[] })).data);
  return { data: [...first.data, ...more.flat()] };
}
async function buildContext(today: string) {
  const [cur, prev] = seasons(today);
  const consulted = parisStamp();
  const q = (season: string) => `cayenneExp=seasonId=${season}%20and%20gameTypeId=2`;
  const [teamsList, standings, sumCur, sumPrev, skCur, skPrev, toiCur, gkCur, gkPrev, onCur, onPrev, pctCur, shCur, shPrev] = await Promise.all([
    safe(`${S}/team`, { data: [] as any[] }),
    get(`${W}/standings/now`),
    safe(`${S}/team/summary?limit=-1&${q(cur)}`, { data: [] as any[] }),
    safe(`${S}/team/summary?limit=-1&${q(prev)}`, { data: [] as any[] }),
    pages(`${S}/skater/summary?${q(cur)}`),
    pages(`${S}/skater/summary?${q(prev)}`),
    pages(`${S}/skater/timeonice?${q(cur)}`),
    pages(`${S}/goalie/summary?${q(cur)}`),
    pages(`${S}/goalie/summary?${q(prev)}`),
    pages(`${S}/skater/goalsForAgainst?${q(cur)}`),
    pages(`${S}/skater/goalsForAgainst?${q(prev)}`),
    // PDO (réussite au tir + % d'arrêts à 5 contre 5) et Corsi (tentatives de tir) : la chance d'un côté, la domination de l'autre
    safe(`${S}/team/percentages?limit=-1&${q(cur)}`, { data: [] as any[] }),
    safe(`${S}/team/summaryshooting?limit=-1&${q(cur)}`, { data: [] as any[] }),
    safe(`${S}/team/summaryshooting?limit=-1&${q(prev)}`, { data: [] as any[] }),
  ]);
  const id2abbr: Record<number, string> = Object.fromEntries(teamsList.data.map((t: any) => [t.id, t.triCode]));
  const st: Record<string, any> = Object.fromEntries(standings.standings.map((s: any) => [nm(s.teamAbbrev), s]));
  const abbrs = Object.keys(st).sort();
  const byTeam = (rows: any[]) => Object.fromEntries(rows.filter(r => id2abbr[r.teamId]).map(r => [id2abbr[r.teamId], r]));
  const byId = (rows: any[]) => new Map(rows.map(r => [r.playerId, r]));
  const sched: Record<string, any[]> = Object.fromEntries(await pool(abbrs, 16, async a => [a, (await safe(`${W}/club-schedule-season/${a}/${cur}`, { games: [] as any[] })).games] as const));
  const nickUpper: Record<string, string> = {};
  for (const a of abbrs) nickUpper[nm(st[a].teamCommonName).toUpperCase()] = a;
  const sc = byTeam(sumCur.data), sp = byTeam(sumPrev.data);
  const gp = Object.values(sc).reduce((s: number, t: any) => s + t.gamesPlayed, 0);
  const gf = Object.values(sc).reduce((s: number, t: any) => s + t.goalsFor, 0);
  const gpp = Object.values(sp).reduce((s: number, t: any) => s + t.gamesPlayed, 0) || 1;
  const gfp = Object.values(sp).reduce((s: number, t: any) => s + t.goalsFor, 0);
  const w = gp / (gp + 300);
  const league = w * (gp ? gf / gp : 0) + (1 - w) * (gfp / gpp || 3.0);
  // réussite au tir de la ligue (pour juger les équipes sur leurs tirs, moins soumis à la chance que les buts)
  const shotsAll = Object.values(sp).reduce((s: number, t: any) => s + t.shotsForPerGame * t.gamesPlayed, 0);
  const lgSh = shotsAll ? gfp / shotsAll : 0.1;
  const pc = byTeam(pctCur.data), shc = byTeam(shCur.data), shp = byTeam(shPrev.data);
  let s5 = 0, g5 = 0; for (const t of Object.keys(pc)) if (shc[t]?.shots5v5 && pc[t].shootingPct5v5 != null) { s5 += shc[t].shots5v5; g5 += shc[t].shots5v5 * pc[t].shootingPct5v5; }
  const lgSh5 = s5 > 500 ? g5 / s5 : 0.08;
  return { today, cur, prev, consulted, st, abbrs, sc, sp, sched, nickUpper, league, lgSh, pc, shc, shp, lgSh5, xgT: {} as Record<string, any>, onCur: byId(onCur.data), onPrev: byId(onPrev.data),
    skCur: byId(skCur.data), skPrev: byId(skPrev.data), toi: byId(toiCur.data), gkCur: byId(gkCur.data), gkPrev: byId(gkPrev.data) };
}
type Ctx = Awaited<ReturnType<typeof buildContext>>;

function teamResult(g: any, ab: string) {
  if (!FINAL.includes(g.gameState) || !GAME_TYPES.includes(g.gameType)) return null;
  const home = g.homeTeam.abbrev === ab;
  const me = home ? g.homeTeam : g.awayTeam, op = home ? g.awayTeam : g.homeTeam;
  if (me.score == null) return null;
  const lp = g.gameOutcome?.lastPeriodType || 'REG';
  return { date: g.gameDate, opp: op.abbrev, home, gf: me.score, ga: op.score, res: me.score > op.score ? 'V' : (['OT', 'SO'].includes(lp) ? 'P' : 'D'), mode: lp };
}
const teamGames = (ctx: Ctx, ab: string, before: string) => (ctx.sched[ab] || []).map(g => teamResult(g, ab)).filter((r: any) => r && r.date < before).sort((a: any, b: any) => a.date.localeCompare(b.date)) as any[];

function teamSv(ctx: Ctx, ab: string) {
  const sv = (t: any) => t && t.gamesPlayed ? 1 - t.goalsAgainst / Math.max(1, t.shotsAgainstPerGame * t.gamesPlayed) : null;
  const c = ctx.sc[ab], p = ctx.sp[ab];
  const sa = c ? c.shotsAgainstPerGame * c.gamesPlayed : 0;
  const w = sa / (sa + 600);
  return w * (sv(c) ?? 0.9) + (1 - w) * (sv(p) ?? 0.9);
}

/** Buteur du soir : un seul joueur, le plus probable de marquer après contrôle de tout ce qui peut le faire échouer. */
function buteurDuSoir(ctx: Ctx, games: any[], players: any[], started: Set<number>, lineups: Record<string, GameLineup>, db: any) {
  const gById = new Map(games.map(g => [g.game_id, g]));
  const cands = players.filter(p => {
    const g = gById.get(p.game_id);
    if (!g || started.has(p.game_id) || /absent|incertain/i.test(p.statut)) return false;
    if ((p.mj || 0) + (p.prev_mj || 0) < 40) return false;                 // historique trop court
    if (p.pos === 'D' || (p.toi_sec && p.toi_sec < 16 * 60)) return false; // les buteurs fiables sont des attaquants à gros temps de jeu
    return p.p_but != null;
  }).map(p => {
    const g = gById.get(p.game_id);
    const L = lineups[`${g.exterieur}@${g.domicile}`];
    const known = !!L;
    let score = p.p_but;
    if (!known) score *= 0.95;                         // composition pas encore publiée : petite prudence
    if ((p.chance ?? 0) >= 1.8) score *= 0.95;          // série flatteuse : historiquement un peu moins bien que prévu
    if (g.b2b?.includes(p.equipe)) score *= 0.97;       // 2e match en 2 soirs
    return { p, g, L, score };
  }).sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (!best) return null;
  const { p, g, L } = best;
  const opp = p.equipe === g.domicile ? g.exterieur : g.domicile;
  const home = p.equipe === g.domicile;
  const tl = L ? (home ? L.home : L.away) : null;
  const ligne = tl?.lines.find((l: string) => l.split(' -- ').some(x => nameMatch(p.nom, x)));
  const partenaires = ligne ? ligne.split(' -- ').filter((x: string) => !nameMatch(p.nom, x)) : [];
  const ts = teamSnapshot(ctx, p.equipe), os = teamSnapshot(ctx, opp);
  const gk = g.gardiens?.[opp];
  const xgTeam = home ? g.buts_attendus_dom : g.buts_attendus_ext;
  const lg = ctx.league;
  const risques: string[] = [];
  if (!L) risques.push('Composition nhl.com pas encore publiée : sa place dans l’alignement n’est pas confirmée.');
  if (!gk?.stats) risques.push(`Gardien partant de ${opp} inconnu.`);
  else if ((gk.stats.pct_arrets ?? gk.stats.prev_pct_arrets ?? 0) >= 0.915) risques.push(`${gk.nom} est un très bon gardien (${gk.stats.pct_arrets ?? gk.stats.prev_pct_arrets} d'arrêts).`);
  if ((p.chance ?? 0) >= 1.8) risques.push('Il marque plus que ses tirs ne le justifient ces derniers temps : cette réussite peut retomber.');
  if (g.b2b?.includes(p.equipe)) risques.push(`${p.equipe} joue son 2e match en 2 soirs.`);
  if ((os.pct_dn ?? 0) >= 83) risques.push(`${opp} tue très bien les pénalités (${os.pct_dn} %) : peu de buts en avantage numérique à espérer.`);
  if ((os.bc_match ?? lg) < lg - 0.3) risques.push(`${opp} encaisse peu (${os.bc_match} buts par match).`);
  const atouts: string[] = [];
  if ((p.l10_tirs_match ?? 0) >= 3.5) atouts.push(`Gros volume de tirs : ${p.l10_tirs_match} par match sur ses 10 derniers.`);
  if ((p.pp_sec ?? 0) >= 180) atouts.push(`Pilier de l'avantage numérique (${p.toi_an} par match).`);
  if ((os.bc_match ?? lg) > lg + 0.3) atouts.push(`${opp} encaisse beaucoup (${os.bc_match} buts par match).`);
  if (gk?.stats && (gk.stats.pct_arrets ?? gk.stats.prev_pct_arrets ?? 1) < 0.895) atouts.push(`Gardien adverse en difficulté : ${gk.nom}, ${gk.stats.pct_arrets ?? gk.stats.prev_pct_arrets} d'arrêts.`);
  if ((p.chance ?? 0) <= -1.5) atouts.push('Malchanceux récemment : beaucoup de tirs, peu de buts. Historiquement, ces joueurs ont un peu mieux réussi que prévu.');
  if (xgTeam >= 3.4) atouts.push(`${p.equipe} devrait marquer beaucoup ce soir (${xgTeam} buts attendus).`);
  const hist = (db.predictions || []).filter((x: any) => x.type === 'Buteur du soir' && (x.resultat === 0 || x.resultat === 1));
  return {
    id: p.id, nom: p.nom, equipe: p.equipe, opp, pos: p.pos, game_id: p.game_id, match: p.match, debut: g.debut_paris,
    p_but: p.p_but, p_point: p.p_point, cote_juste: r3(1 / p.p_but, 2),
    joueur: {
      ligne: p.ligne, partenaires, toi: p.toi, toi_recent: p.toi_recent || null, toi_an: p.toi_an,
      buts: `${p.buts} en ${p.mj} matchs cette saison (${p.buts_match ?? '—'} par match)`, saison_prec: p.prev_mj ? `${p.prev_buts_match} but par match sur ${p.prev_mj} matchs la saison dernière` : 'pas de saison précédente',
      tirs: `${p.tirs_match_attendus} tirs attendus par match, ${p.l10_tirs_match ?? '—'} sur les 10 derniers`, reussite: `${p.reussite_attendue} % de réussite au tir de référence`,
      dix_derniers: `${p.l10_buts_match ?? '—'} but par match sur ses 10 derniers`, sequence: p.sequence, lecture: p.lecture, vs_adv: p.vs_adv,
    },
    equipe_info: { nom: ts.nom, bilan: `${ts.v}-${ts.d}-${ts.dp}`, forme: ts.bilan10, bp: ts.bp_match, an: ts.pct_an, xg_ce_soir: xgTeam, total_marche: g.total_marche ?? null },
    adversaire: { nom: os.nom, bilan: `${os.v}-${os.d}-${os.dp}`, forme: os.bilan10, bc: os.bc_match, tirs_contre: os.tirs_contre_match, dn: os.pct_dn,
      gardien: gk?.nom || 'non connu', gardien_statut: gk?.statut || 'non disponible', gardien_sv: gk?.stats?.pct_arrets ?? null, gardien_sv_prec: gk?.stats?.prev_pct_arrets ?? null },
    atouts, risques,
    autres: cands.slice(1, 4).map(c => ({ nom: c.p.nom, equipe: c.p.equipe, p_but: c.p.p_but })),
    verdict: p.p_but >= 0.45 ? 'Meilleure chance de la soirée, au niveau des meilleurs buteurs de la ligue.' : p.p_but >= 0.38 ? 'Bon candidat, mais même les meilleurs buteurs ne marquent qu’environ 4 matchs sur 10.' : 'Soirée sans buteur évident : petite mise ou passer.',
    historique: { n: hist.length, gagnes: hist.filter((x: any) => x.resultat === 1).length },
  };
}

function teamSnapshot(ctx: Ctx, ab: string) {
  const s = ctx.st[ab], m = ctx.sc[ab] || {};
  const last10 = teamGames(ctx, ab, addDays(ctx.today, 1)).slice(-10);
  const streak = `${s.streakCode || ''}${s.streakCount || ''}`.replace('OT', 'P').replace('W', 'V').replace('L', 'D');
  const svc = m.gamesPlayed ? 1 - m.goalsAgainst / Math.max(1, m.shotsAgainstPerGame * m.gamesPlayed) : null;
  return {
    equipe: ab, nom: nm(s.teamName), division: s.divisionName, conference: s.conferenceName,
    mj: s.gamesPlayed, v: s.wins, d: s.losses, dp: s.otLosses, pts: s.points, pct_pts: r3(s.pointPctg),
    rang_div: s.divisionSequence, rang_conf: s.conferenceSequence, rang_ligue: s.leagueSequence,
    bp_match: r3(m.goalsForPerGame, 2), bc_match: r3(m.goalsAgainstPerGame, 2), tirs_match: r3(m.shotsForPerGame, 1), tirs_contre_match: r3(m.shotsAgainstPerGame, 1),
    pct_an: m.powerPlayPct != null ? r3(m.powerPlayPct * 100, 1) : null, pct_dn: m.penaltyKillPct != null ? r3(m.penaltyKillPct * 100, 1) : null,
    pct_arrets: r3(svc), pdo: ctx.pc[ab]?.shootingPlusSavePct5v5 != null ? r3(ctx.pc[ab].shootingPlusSavePct5v5 * 1000, 0) : null,
    corsi: ctx.pc[ab]?.satPct != null ? r3(ctx.pc[ab].satPct * 100, 1) : null, corsi_serre: ctx.pc[ab]?.satPctClose != null ? r3(ctx.pc[ab].satPctClose * 100, 1) : null,
    ...(() => { const r = teamRates(ctx, ab); return { chance_bm: r3(r.chance, 2), xgf: r.xgf != null ? r3(r.xgf, 2) : null, xga: r.xga != null ? r3(r.xga, 2) : null }; })(), bilan10: `${s.l10Wins}-${s.l10Losses}-${s.l10OtLosses}`, forme10: last10.map((g: any) => g.res), serie: streak,
    dom: `${s.homeWins}-${s.homeLosses}-${s.homeOtLosses}`, ext: `${s.roadWins}-${s.roadLosses}-${s.roadOtLosses}`,
  };
}

// ------------------------------------------------------------------ résultats et évaluation
function boxPlayers(box: any) {
  const out = new Map<number, any>();
  for (const side of ['awayTeam', 'homeTeam']) {
    const t = box?.playerByGameStats?.[side] || {};
    for (const grp of ['forwards', 'defense', 'goalies']) for (const p of t[grp] || []) out.set(p.playerId, { ...p, team: box[side]?.abbrev, grp, side });
  }
  return out;
}
function starterOf(box: any, side: 'awayTeam' | 'homeTeam') {
  const g = (box?.playerByGameStats?.[side]?.goalies || []).filter((x: any) => x.toi && x.toi !== '00:00');
  const sec = (t: string) => { const [m, s] = t.split(':').map(Number); return m * 60 + s; };
  g.sort((a: any, b: any) => (b.starter ? 1 : 0) - (a.starter ? 1 : 0) || sec(b.toi) - sec(a.toi));
  return g[0] ? nm(g[0].name) : null;
}
function highlights(g: any, box: any) {
  const f: string[] = [];
  const lp = g.gameOutcome?.lastPeriodType || 'REG';
  if (lp === 'OT') f.push('Décidé en prolongation'); if (lp === 'SO') f.push('Décidé aux tirs de barrage');
  if (Math.min(g.awayTeam.score, g.homeTeam.score) === 0) f.push('Blanchissage');
  if (g.awayTeam.score + g.homeTeam.score >= 9) f.push(`Match prolifique (${g.awayTeam.score + g.homeTeam.score} buts)`);
  for (const p of boxPlayers(box).values()) {
    if (p.grp === 'goalies') continue;
    if (p.goals >= 3) f.push(`Tour du chapeau : ${nm(p.name)} (${p.team})`); else if (p.goals === 2) f.push(`Doublé : ${nm(p.name)} (${p.team})`);
    if (p.points >= 3) f.push(`${p.points} points : ${nm(p.name)} (${p.team})`);
  }
  return f;
}

async function gradeAndResults(ctx: Ctx, db: any, yday: string, params: Params) {
  const pending = db.predictions.filter((p: any) => p.resultat == null && p.date < ctx.today);
  const ids = [...new Set<number>([...pending.flatMap((p: any) => [p.game_id, ...(p.legs || []).map((l: any) => l.game_id)]), ...(db.signals || []).filter((x: any) => x.res == null && x.date < ctx.today).map((x: any) => x.game_id)])];
  const ydayGames = (await safe(`${W}/score/${yday}`, { games: [] as any[] })).games.filter((g: any) => GAME_TYPES.includes(g.gameType));
  for (const g of ydayGames) if (!ids.includes(g.id)) ids.push(g.id);
  const boxes = new Map<number, any>((await pool(ids, 16, async id => [id, await safe(`${W}/gamecenter/${id}/boxscore`, null)] as const)).filter(([, b]) => b));
  // « Les deux marquent » : buts par période (temps réglementaire) lus dans le score nhl.com du jour du match
  const perGoals = new Map<number, number[][]>();
  for (const d of [...new Set<string>(pending.filter((p: any) => p.type.startsWith('Deux marquent')).map((p: any) => p.date))]) {
    const gs = d === yday ? ydayGames : (await safe(`${W}/score/${d}`, { games: [] as any[] })).games;
    for (const g of gs) {
      if (!Array.isArray(g.goals) || !/OFF|FINAL/.test(g.gameState)) continue;
      const s = [[0, 0], [0, 0], [0, 0], [0, 0]];
      for (const x of g.goals) { const per = x.periodDescriptor?.number ?? x.period; if (per >= 1 && per <= 3) { const i = (x.teamAbbrev?.default ?? x.teamAbbrev) === g.homeTeam.abbrev ? 0 : 1; s[per][i]++; s[0][i]++; } }
      perGoals.set(g.id, s);
    }
  }
  let newly = 0;
  for (const p of pending) {
    const box = boxes.get(p.game_id);
    if (!box || !FINAL.includes(box.gameState)) continue;
    const a = box.awayTeam, h = box.homeTeam;
    if (p.type.startsWith('Deux marquent')) {
      const s = perGoals.get(p.game_id); if (!s) continue;
      const both = (k: number) => +(s[k][0] > 0 && s[k][1] > 0);
      p.buts_seg = s; p.res_seg = [0, 1, 2, 3].map(both); p.resultat = both(p.periode || 0);
      newly++; continue;
    }
    if (p.legs) {   // combiné : gagné seulement si chaque joueur fait au moins 1 point
      const lb = p.legs.map((l: any) => boxes.get(l.game_id));
      if (lb.some((b: any) => !b || !FINAL.includes(b.gameState))) continue;
      const res = p.legs.map((l: any, i: number) => gradeLeg(l, lb[i]));
      p.resultat = res.some((x: any) => x == null) ? 'N/J' : +res.every((x: any) => x === 1);
      p.legs_res = res;
      newly++;
      continue;
    }
    if (p.type === 'Sélection équipe' || p.type === 'Lecture pro') {
      p.resultat = (a.score > h.score ? a.abbrev : h.abbrev) === p.selection_abbr ? 1 : 0;
    } else if (p.type === 'Vainqueur') {
      p.resultat = (a.score > h.score ? a.abbrev : h.abbrev) === p.selection_abbr ? 1 : 0;
      const real = { ext: starterOf(box, 'awayTeam'), dom: starterOf(box, 'homeTeam') };
      p.gardiens_reels = real;
      p.gardiens_check = Object.fromEntries((['ext', 'dom'] as const).map(s => [s, p.gardiens_prevus?.[s] && real[s] ? nameMatch(p.gardiens_prevus[s], real[s]!) : null]));
    } else {
      const st = boxPlayers(box).get(p.player_id);
      const tk = p.type.match(/tirs (\d)\+/), mp = p.type.match(/(\d)\+ (points|buts)/);
      p.resultat = !st ? 'N/J' : mp ? +((mp[2] === 'buts' ? st.goals : st.points) >= +mp[1]) : tk ? +((st.sog || 0) >= +tk[1]) : (/but/i.test(p.type) ? +(st.goals > 0) : /passe/i.test(p.type) ? +(st.assists > 0) : +(st.points > 0));
    }
    newly++;
    postMatch(db, p, box, params);
  }
  // Signaux extérieurs (public, leaders Covers, mouvement de cote) : on mesure nous-mêmes s'ils gagnent.
  for (const sg of (db.signals || []).filter((x: any) => x.res == null)) {
    const box = boxes.get(sg.game_id);
    if (!box || !FINAL.includes(box.gameState)) continue;
    const win = box.awayTeam.score > box.homeTeam.score ? box.awayTeam.abbrev : box.homeTeam.abbrev;
    const tot = box.awayTeam.score + box.homeTeam.score;
    sg.res = Object.fromEntries(Object.entries(sg.picks).filter(([, v]) => v).map(([k, v]) => [k, +(v === win)]));
    if (sg.ou?.line != null) sg.ou_res = Object.fromEntries(Object.entries(sg.ou).filter(([k, v]) => k !== 'line' && v && tot !== sg.ou.line).map(([k, v]) => [k, +((v === 'over') === (tot > sg.ou.line))]));
  }
  const results: any[] = [];
  for (const g of ydayGames) {
    const box = boxes.get(g.id);
    if (!FINAL.includes(g.gameState)) continue;
    const lp = g.gameOutcome?.lastPeriodType || 'REG';
    results.push({
      date: yday, game_id: g.id, exterieur: g.awayTeam.abbrev, domicile: g.homeTeam.abbrev, score_ext: g.awayTeam.score, score_dom: g.homeTeam.score,
      mode: ({ REG: 'Temps réglementaire', OT: 'Prolongation', SO: 'Tirs de barrage' } as any)[lp] || lp,
      tirs_ext: g.awayTeam.sog, tirs_dom: g.homeTeam.sog, lieu: nm(g.venue),
      vainqueur: g.awayTeam.score > g.homeTeam.score ? g.awayTeam.abbrev : g.homeTeam.abbrev,
      gardiens: box ? `${starterOf(box, 'awayTeam') || '?'} / ${starterOf(box, 'homeTeam') || '?'}` : null,
      faits: highlights(g, box), source: 'nhl.com', consulte: ctx.consulted,
    });
  }
  db.results = db.results.filter((r: any) => !results.some(x => x.game_id === r.game_id)).concat(results);
  return { results, newlyGraded: newly };
}

function missesOf(db: any, day: string) {
  return db.predictions.filter((p: any) => p.date === day && p.type === 'Vainqueur' && p.resultat === 0 && p.prob >= 0.6).map((p: any) => {
    const causes: string[] = [];
    for (const s of ['ext', 'dom']) if (p.gardiens_check?.[s] === false) causes.push(`gardien ${s === 'ext' ? p.exterieur : p.domicile} prévu ${p.gardiens_prevus[s]}, a joué ${p.gardiens_reels[s]}`);
    if (p.confiance === 'Faible') causes.push('confiance faible (peu de données)');
    if (p.feat?.mkt_h != null) { const mk = p.selection_abbr === p.domicile ? p.feat.mkt_h : 1 - p.feat.mkt_h; if (mk < p.prob - 0.05) causes.push(`le marché était moins confiant (${Math.round(mk * 100)} %)`); }
    if (p.selection_abbr === p.domicile ? p.feat?.b2b_h : p.feat?.b2b_a) causes.push('favori en 2e match en 2 soirs');
    return { match: p.match, favori: p.selection, prob: p.prob, causes: causes.length ? causes : ['aucune cause identifiable dans les données : variance normale du hockey'] };
  });
}

// ------------------------------------------------------------------ soirée
const blendRate = (curN: number, curRate: number, prevN: number, prevRate: number, k: number, prior: number) => {
  const wc = curN ? curN / (curN + k) : 0;
  const base = prevN >= 10 ? prevRate : (prevRate * prevN + prior * (10 - prevN)) / 10;
  return wc * curRate + (1 - wc) * base;
};

function teamRates(ctx: Ctx, ab: string, params?: Params) {
  const c = ctx.sc[ab] || {}, p = ctx.sp[ab] || {};
  const n = c.gamesPlayed || 0, w = n / (n + 12), lg = ctx.league;
  const gf = w * (c.goalsForPerGame ?? lg) + (1 - w) * (p.goalsForPerGame ?? lg), ga = w * (c.goalsAgainstPerGame ?? lg) + (1 - w) * (p.goalsAgainstPerGame ?? lg);
  // Les tirs disent mieux la force réelle que les buts (moins de chance) : moitié buts, moitié tirs x réussite moyenne.
  const ws = n / (n + 6);
  const sf = ws * (c.shotsForPerGame ?? 0) + (1 - ws) * (p.shotsForPerGame ?? 0), sa = ws * (c.shotsAgainstPerGame ?? 0) + (1 - ws) * (p.shotsAgainstPerGame ?? 0);
  const gfS = sf ? sf * ctx.lgSh : gf, gaS = sa ? sa * ctx.lgSh : ga;
  // PDO : les buts à 5 contre 5 venus d'une réussite au tir / d'un % d'arrêts hors norme sont surtout de la chance.
  // On ramène réussite et arrêts vers la moyenne de la ligue (400 tirs « fictifs » à la moyenne) et on retire l'écart.
  const pc = ctx.pc[ab], s5 = ctx.shc[ab];
  let luckF = 0, luckA = 0, pdo: number | null = null;
  if (n && pc && s5?.shots5v5 && pc.shootingPct5v5 != null && pc.savePct5v5 != null) {
    const K = 400, L5 = ctx.lgSh5, s5f = s5.shots5v5, s5a = s5f * (s5.satAgainst / Math.max(1, s5.satFor));
    const g5f = pc.shootingPct5v5 * s5f, g5a = (1 - pc.savePct5v5) * s5a;
    luckF = (g5f - s5f * (g5f + L5 * K) / (s5f + K)) / n; luckA = (g5a - s5a * (g5a + L5 * K) / (s5a + K)) / n;
    pdo = pc.shootingPlusSavePct5v5 ?? null;
  }
  const gfA = gf - w * luckF, gaA = ga - w * luckA;
  // Corsi : part des tentatives de tir (la domination du jeu, le meilleur indicateur de la force future), saison mêlée à la précédente
  const per = (x: any, k: string) => x?.[k] != null && x?.gamesPlayed ? x[k] / x.gamesPlayed : null;
  const cfC = per(s5, 'satFor'), caC = per(s5, 'satAgainst'), cfP = per(ctx.shp[ab], 'satFor'), caP = per(ctx.shp[ab], 'satAgainst');
  const cf = cfC != null && cfP != null ? ws * cfC + (1 - ws) * cfP : (cfC ?? cfP), ca = caC != null && caP != null ? ws * caC + (1 - ws) * caP : (caC ?? caP);
  const corsi = cf && ca ? cf / (cf + ca) : null;
  const tot = gfS + gaS, gfC = corsi != null ? tot * corsi : gfS, gaC = corsi != null ? tot * (1 - corsi) : gaS;
  // xG : buts attendus d'après la position et le type de chaque tir (modèle maison, play-by-play LNH), mêlés à la saison passée
  const X = ctx.xgT?.[ab];
  const xw = X?.n ? X.n / (X.n + 6) : 0, cF = X?.n ? X.xgf / X.n : null, cA = X?.n ? X.xga / X.n : null;
  const mixX = (c: number | null, pv: number | undefined) => c != null && pv != null ? xw * c + (1 - xw) * pv : (c ?? pv ?? null);
  const xF = X && X.n >= 3 || X?.pxgf != null ? mixX(cF, X?.pxgf) : null, xA = X && X.n >= 3 || X?.pxga != null ? mixX(cA, X?.pxga) : null;
  // Mélange : poids de départ calés sur 2025-26 rejoué jour par jour, puis réappris chaque nuit sur les vrais résultats (learn.mts).
  const cmp = [gfA, gfS, gfC, xF, gaA, gaS, gaC, xA].map(v => v == null ? null : r3(v, 3));
  const T = teamStrength(cmp, lg, params ?? defaultParams());
  return { gf: T.gf, ga: T.ga, n, gfRaw: gf, pdo, corsi, chance: n ? luckF - luckA : 0, cmp, xgf: xF, xga: xA };
}

/** xG : ajoute les matchs terminés qui manquent (40 au plus par passage), puis fait les totaux par équipe. */
async function updateXg(ctx: Ctx, db: any) {
  db.xg ||= {};
  const seed: any = xgSeed;
  if (!Object.keys(db.xg).length && seed.games) Object.assign(db.xg, seed.games);
  const y4 = ctx.cur.slice(0, 4), todo = new Map<number, any>();
  for (const ab of ctx.abbrs) for (const g of ctx.sched[ab] || []) {
    const id = String(g.id);
    if (id.startsWith(y4 + '02') && FINAL.includes(g.gameState) && !db.xg[id]) todo.set(g.id, g);
  }
  const list = [...todo.values()].sort((a, b) => String(b.gameDate).localeCompare(String(a.gameDate))).slice(0, 40);
  let added = 0;
  await pool(list, 10, async (g: any) => {
    const d = await safe(`${W}/gamecenter/${g.id}/play-by-play`, null as any);
    if (!d?.plays?.length || !FINAL.includes(d.gameState)) return;
    const x = gameXg(d);
    db.xg[String(g.id)] = [d.gameDate || g.gameDate, nm(d.homeTeam?.abbrev), nm(d.awayTeam?.abbrev), x.xg_h, x.xg_a];
    added++;
  });
  const T: Record<string, any> = {};
  const add = (t: string, f: number, a: number) => { const o = T[t] ||= { n: 0, xgf: 0, xga: 0 }; o.n++; o.xgf += f; o.xga += a; };
  for (const [id, v] of Object.entries(db.xg) as [string, any][]) {
    if (!id.startsWith(y4 + '02') || !(v[0] < ctx.today)) continue;
    add(v[1], v[3], v[4]); add(v[2], v[4], v[3]);
  }
  for (const ab of ctx.abbrs) { const pv = seed.prev?.[ab]; if (pv) { const o = T[ab] ||= { n: 0, xgf: 0, xga: 0 }; o.pxgf = pv[0]; o.pxga = pv[1]; } }
  ctx.xgT = T;
  return added;
}

function goalieLine(ctx: Ctx, id: number) {
  const c = ctx.gkCur.get(id), p = ctx.gkPrev.get(id);
  const sa = c?.shotsAgainst || 0, w = sa / (sa + 600);
  const svB = (c || p) ? w * (c?.savePct ?? 0.9) + (1 - w) * (p?.savePct ?? 0.9) : 0.9;
  return { id, nom: c?.goalieFullName || p?.goalieFullName, mj: c?.gamesPlayed || 0, pct_arrets: r3(c?.savePct), moy_bc: r3(c?.goalsAgainstAverage, 2), prev_pct_arrets: r3(p?.savePct), prev_mj: p?.gamesPlayed || 0, sv_blend: svB };
}

async function buildEvening(ctx: Ctx, db: any, params: Params, mode: string) {
  const today = ctx.today;
  const games = (await safe(`${W}/score/${today}`, { games: [] as any[] })).games.filter((g: any) => GAME_TYPES.includes(g.gameType));
  const odds = await safe(`${W}/partner-game/US/now`, { games: [] as any[], currentOddsDate: null as any, bettingPartner: null as any, lastUpdatedUTC: null as any });
  const oddsById = new Map(odds.games.map((g: any) => [g.gameId, g]));
  const oddsInfo = odds.games.length ? `${odds.bettingPartner?.name ? odds.bettingPartner.name + ', ' : ''}mise à jour ${odds.lastUpdatedUTC ? parisStamp(new Date(odds.lastUpdatedUTC)) : 'n.d.'}` : 'non disponible';
  const placeToAbbr: Record<string, string> = {};
  for (const ab of ctx.abbrs) placeToAbbr[norm(nm(ctx.st[ab].placeName))] = ab;
  const nickOf: Record<string, string> = Object.fromEntries(ctx.abbrs.map(ab => [ab, nm(ctx.st[ab].teamCommonName)]));
  const [cov, tb, OL] = await Promise.all([   // en parallèle : Covers et OLBG ne doivent pas rallonger l'analyse
    games.length ? fetchCovers(placeToAbbr) : Promise.resolve({ ok: false, reason: 'aucun match', games: [] as any[] }),
    games.length ? fetchTopBettors(placeToAbbr) : Promise.resolve({ ok: false, reason: '', parieurs: [] as any[], paris: [] as any[], n_classes: 0, seuil_chance: 0 }),
    games.length ? fetchOlbg('nhl', games.map((g: any) => ({ ext: g.awayTeam.abbrev, dom: g.homeTeam.abbrev })), nickOf).catch(() => ({ ok: false, reason: 'olbg.com inaccessible', games: [] as any[] })) : Promise.resolve({ ok: false, reason: 'aucun match', games: [] as any[] }),
  ]);
  const covBy = new Map(cov.games.map((c: any) => [`${c.away}@${c.home}`, c]));
  const olbgInfo = OL.ok ? `${ctx.consulted} (${OL.games.length} match(s)${OL.reason ? ", " + OL.reason : ""})` : `non disponible (${OL.reason})`;
  const coversInfo = cov.ok ? `${ctx.consulted} (${cov.games.length} match(s))` : `non disponible (${cov.reason})`;
  db.odds_open = db.odds_open || {};

  const injuries: any[] = [];
  const outGames: any[] = [];
  const outPlayers: any[] = [];
  const newPreds: any[] = [];
  const newOdds: any[] = [];
  const startedIds = new Set<number>();

  // effectifs des équipes du soir (en parallèle)
  const teamsTonight = [...new Set<string>(games.flatMap((g: any) => [g.awayTeam.abbrev, g.homeTeam.abbrev]))];
  const rosters: Record<string, any> = Object.fromEntries(await pool(teamsTonight, 16, async a => [a, await safe(`${W}/roster/${a}/current`, {} as any)] as const));
  // Compositions nhl.com : chaque joueur est classé par sa position officielle (effectif du jour)
  const posOf = (team: string, name: string) => {
    const r = rosters[team] || {};
    if ((r.goalies || []).some((x: any) => nameMatch(`${nm(x.firstName)} ${nm(x.lastName)}`, name))) return 'G' as const;
    if ((r.defensemen || []).some((x: any) => nameMatch(`${nm(x.firstName)} ${nm(x.lastName)}`, name))) return 'D' as const;
    if ((r.forwards || []).some((x: any) => nameMatch(`${nm(x.firstName)} ${nm(x.lastName)}`, name))) return 'F' as const;
    return null;
  };
  const lu = games.length ? await fetchLineups(today, ctx.cur, ctx.nickUpper, posOf) : { ok: false, reason: 'aucun match', games: {} as Record<string, GameLineup>, url: '' };
  const lineupInfo = lu.ok ? `${ctx.consulted}` : `non disponible (${lu.reason})`;
  const prevSched: Record<string, any[]> = Object.fromEntries(await pool(teamsTonight, 16, async a => [a, (await safe(`${W}/club-schedule-season/${a}/${ctx.prev}`, { games: [] as any[] })).games] as const));

  const perGame = await pool(games, 8, async (g: any) => {
    const a = g.awayTeam.abbrev, h = g.homeTeam.abbrev, key = `${a}@${h}`;
    const L = lu.games[key];
    const started = !NOT_STARTED.includes(g.gameState);
    // blessures (article nhl.com)
    const inj: any[] = [];
    if (L) for (const [ab, tl] of [[a, L.away], [h, L.home]] as const) {
      for (const i of tl.injured) inj.push({ team: ab, player: i.player, status: 'Confirmé absent', detail: `Blessé : ${i.detail}`, updated: today, source: 'nhl.com' });
      for (const s of tl.suspended) inj.push({ team: ab, player: s, status: 'Confirmé absent', detail: 'Suspendu', updated: today, source: 'nhl.com' });
      for (const u of L.uncertain.filter(u => u.team === ab && !inj.some(x => x.player === u.player))) inj.push({ team: ab, player: u.player, status: 'Incertain', detail: u.detail, updated: today, source: 'nhl.com' });
    }
    // caractéristiques
    const ra = teamRates(ctx, a, params), rh = teamRates(ctx, h, params);
    const form = (ab: string) => { const s = ctx.st[ab]; const n = s.l10GamesPlayed || 0; return n >= 3 ? (s.l10Points / (2 * n)) - 0.5 : 0; };
    const lastA = teamGames(ctx, a, today).slice(-1)[0], lastH = teamGames(ctx, h, today).slice(-1)[0];
    const rest = { [a]: lastA ? daysBetween(lastA.date, today) - 1 : null, [h]: lastH ? daysBetween(lastH.date, today) - 1 : null } as Record<string, number | null>;
    const goalies: any = {};
    const gEff: Record<string, number> = { [a]: 1, [h]: 1 };
    for (const [ab, tl] of [[a, L?.away], [h, L?.home]] as const) {
      const name = tl?.goalies?.[0];
      const rg = (rosters[ab]?.goalies || []) as any[];
      const m = name ? rg.find(x => nameMatch(`${nm(x.firstName)} ${nm(x.lastName)}`, name)) : null;
      const line = m ? goalieLine(ctx, m.id) : null;
      const statut = !name ? 'non disponible' : (L!.confirmedGoalies.some(c => nameMatch(name, c)) ? 'confirmé' : 'probable');
      goalies[ab] = { nom: line?.nom || name || 'non disponible', statut, stats: line, autres: rg.map(x => { const gl = goalieLine(ctx, x.id); return `${nm(x.firstName)} ${nm(x.lastName)} (${gl.mj} MJ, ${gl.pct_arrets ?? 'n.d.'})`; }) };
      if (line) gEff[ab] = clamp((1 - line.sv_blend) / (1 - teamSv(ctx, ab)), 0.85, 1.15);
    }
    const injLoss = (ab: string, gfBase: number) => {
      let loss = 0; const names: string[] = [];
      for (const i of inj.filter(x => x.team === ab && x.status === 'Confirmé absent')) {
        const sk = [...ctx.skCur.values(), ...ctx.skPrev.values()].find((s: any) => s.teamAbbrevs?.split(',').includes(ab) && nameMatch(s.skaterFullName, i.player));
        if (!sk) continue;
        const c = ctx.skCur.get(sk.playerId), p = ctx.skPrev.get(sk.playerId);
        const ppg = blendRate(c?.gamesPlayed || 0, c ? c.points / Math.max(1, c.gamesPlayed) : 0, p?.gamesPlayed || 0, p ? p.points / Math.max(1, p.gamesPlayed) : 0, 10, 0.3);
        loss += ppg; if (ppg >= 0.5) names.push(i.player);
      }
      return { ratio: loss / Math.max(gfBase, 1), names };
    };
    const ia = injLoss(a, ra.gf), ih = injLoss(h, rh.gf);
    const h2hRows = [...(prevSched[h] || []).map(x => teamResult(x, h)), ...teamGames(ctx, h, today)].filter((r: any) => r && r.opp === a && r.date < today).slice(-5) as any[];
    const h2h = h2hRows.length >= 2 ? h2hRows.filter(r => r.res === 'V').length / h2hRows.length - 0.5 : 0;
    // cotes nhl.com (partenaire) — uniquement avant le début du match (sinon cotes en direct)
    const o: any = oddsById.get(g.id);
    const pick = (side: any, desc: string, draw = false) => side?.odds?.find((x: any) => x.description === desc && (draw ? x.qualifier === 'Draw' : x.qualifier !== 'Draw'))?.value;
    const mlA = !started ? americanToDecimal(pick(o?.awayTeam, 'MONEY_LINE_2_WAY')) : null, mlH = !started ? americanToDecimal(pick(o?.homeTeam, 'MONEY_LINE_2_WAY')) : null;
    const x3H = !started ? americanToDecimal(pick(o?.homeTeam, 'MONEY_LINE_3_WAY')) : null, x3A = !started ? americanToDecimal(pick(o?.awayTeam, 'MONEY_LINE_3_WAY')) : null, x3D = !started ? americanToDecimal(pick(o?.homeTeam, 'MONEY_LINE_3_WAY', true)) : null;
    const mkt = mlA && mlH ? (1 / mlH) / (1 / mlA + 1 / mlH) : null;
    const ouAll = !started ? [...(o?.homeTeam?.odds || []), ...(o?.awayTeam?.odds || [])].filter((x: any) => x.description === 'OVER_UNDER') : [];
    const ov = ouAll.find((x: any) => /^O/.test(x.qualifier)), un = ouAll.find((x: any) => /^U/.test(x.qualifier));
    let mL: any = null;
    if (ov && un && mkt != null && ov.qualifier.slice(1) === un.qualifier.slice(1)) {
      const line = parseFloat(ov.qualifier.slice(1)), dO = americanToDecimal(ov.value)!, dU = americanToDecimal(un.value)!;
      const pOver = (1 / dO) / (1 / dO + 1 / dU);
      mL = { ...marketLambdas(line, pOver, mkt), line, pOver, dO, dU };
    }
    const feat: GameFeat = { lg: ctx.league, gfh: rh.gf, gah: rh.ga, gfa: ra.gf, gaa: ra.ga, form_h: form(h), form_a: form(a), b2b_h: rest[h] === 0 ? 1 : 0, b2b_a: rest[a] === 0 ? 1 : 0, g_h: gEff[h], g_a: gEff[a], inj_h: ih.ratio, inj_a: ia.ratio, h2h, mkt_h: mkt, mkt_lh: mL ? r3(mL.lh, 3) : null, mkt_la: mL ? r3(mL.la, 3) : null, cmp_h: rh.cmp, cmp_a: ra.cmp };
    const prModel = gameProbs({ ...feat, mkt_lh: null, mkt_la: null }, params);
    const pr = gameProbs(feat, params);
    const pH = pr.final_h, pA = 1 - pH;
    const value = (pm: number, pi: number | null) => pi == null ? 'Cote non disponible' : (pm - pi >= params.vthr ? 'Valeur potentielle' : pm - pi <= -params.vthr ? 'Cote défavorable' : 'Neutre');
    let r1: any = null;
    if (x3H && x3A && x3D) { const s = 1 / x3H + 1 / x3A + 1 / x3D; r1 = { dom: (1 / x3H) / s, nul: (1 / x3D) / s, ext: (1 / x3A) / s }; }
    // logique
    const facts = [
      `Base : attaque ${h} ${rh.gf.toFixed(2)} B/M contre défense ${a} ${ra.ga.toFixed(2)} BC/M ; attaque ${a} ${ra.gf.toFixed(2)} contre défense ${h} ${rh.ga.toFixed(2)} (saison en cours pondérée avec la précédente)`,
      `Avantage domicile ${h} (+${(params.home * 100).toFixed(1)} % appris)`,
    ];
    // PDO / Corsi : chance et domination du jeu
    for (const [ab, r] of [[a, ra], [h, rh]] as const) {
      if (r.pdo != null && Math.abs(r.chance) >= 0.15) facts.push(r.chance > 0
        ? `${ab} a été chanceux (PDO ${(r.pdo * 1000).toFixed(0)}, environ +${r.chance.toFixed(2)} but/match de réussite hors norme) : le modèle ne la prolonge pas`
        : `${ab} a été malchanceux (PDO ${(r.pdo * 1000).toFixed(0)}, environ ${r.chance.toFixed(2)} but/match) : le modèle attend un retour à la normale`);
      if (r.xgf != null && r.xga != null) facts.push(`${ab} : ${r.xgf.toFixed(2)} buts attendus créés et ${r.xga.toFixed(2)} accordés par match (xG, qualité des tirs)`);
      if (r.corsi != null && Math.abs(r.corsi - 0.5) >= 0.03) facts.push(`${ab} ${r.corsi > 0.5 ? 'domine' : 'subit'} le jeu : ${(r.corsi * 100).toFixed(1)} % des tentatives de tir (Corsi)`);
    }
    for (const ab of [a, h]) { const f = form(ab); if (Math.abs(f) >= 0.15) facts.push(`Forme ${ab} : ${ctx.st[ab].l10Wins}-${ctx.st[ab].l10Losses}-${ctx.st[ab].l10OtLosses} sur ${ctx.st[ab].l10GamesPlayed} matchs`); }
    for (const ab of [a, h]) if (rest[ab] === 0) facts.push(`${ab} joue un 2e match en 2 soirs`);
    for (const ab of [a, h]) {
      const gg = goalies[ab];
      if (gg.stats) { const e = gEff[ab]; facts.push(`Gardien ${ab} ${gg.nom} (${gg.statut}) : ${Math.abs(e - 1) < 0.04 ? 'dans la moyenne de l’équipe' : e < 1 ? 'meilleur que la moyenne de l’équipe' : 'moins bon que la moyenne de l’équipe'}`); }
      else facts.push(`Gardien partant ${ab} non disponible (aucun ajustement)`);
    }
    if (ia.names.length) facts.push(`Absences importantes ${a} : ${ia.names.join(', ')}`);
    if (ih.names.length) facts.push(`Absences importantes ${h} : ${ih.names.join(', ')}`);
    if (h2hRows.length >= 2) facts.push(`Confrontations récentes (${h2hRows.length}) : ${h} ${h2hRows.filter(r => r.res === 'V').length} V`);
    if (mkt != null) facts.push(`Modèle seul ${h} ${Math.round(pr.model_h * 100)} % ; marché ${Math.round(mkt * 100)} % ; retenu ${Math.round(pH * 100)} % (poids du modèle appris : ${Math.round(params.wm * 100)} %)`);
    if (mL) facts.push(`Cote du total : ${mL.line} buts (plus : ${Math.round(mL.pOver * 100)} %) → le marché attend ${mL.lh.toFixed(2)}–${mL.la.toFixed(2)} (domicile–extérieur). Mon modèle : ${prModel.lh.toFixed(2)}–${prModel.la.toFixed(2)}. Retenu : ${pr.lh.toFixed(2)}–${pr.la.toFixed(2)} (poids du marché ${Math.round(params.wt * 100)} %).`);
    // confiance
    const minGp = Math.min(ra.n, rh.n);
    let score = (minGp >= 10 ? 1 : 0) + (goalies[a].stats && goalies[h].stats ? 1 : 0) + (L ? 1 : 0) + (mkt != null ? 1 : 0);
    let conf = score >= 3 ? 'Élevée' : score === 2 ? 'Moyenne' : 'Faible';
    if (minGp < 5 && conf === 'Élevée') conf = 'Moyenne';

    const game: any = {
      game_id: g.id, date: today, exterieur: a, domicile: h, etat: g.gameState, debut_paris: parisHM(g.startTimeUTC), lieu: nm(g.venue),
      buts_attendus_ext: r3(pr.la, 2), buts_attendus_dom: r3(pr.lh, 2), xgm_dom: r3(prModel.lh, 3), xgm_ext: r3(prModel.la, 3), total_marche: mL ? mL.line : null, p_ext: r3(pA), p_dom: r3(pH), p_modele_dom: r3(pr.model_h), p_marche_dom: r3(mkt),
      p_nul_reg: r3(pr.p_tie), p_reg_ext: r3(pr.p_reg_a), p_reg_dom: r3(pr.p_reg_h),
      cote_ext: r3(mlA, 2), cote_dom: r3(mlH, 2), imp_ext: mkt != null ? r3(1 - mkt) : null, imp_dom: r3(mkt),
      source_cotes: mlA ? `nhl.com (partenaire${odds.bettingPartner?.name ? ' ' + odds.bettingPartner.name : ''})` : null, heure_cotes: mlA ? oddsInfo : null,
      cote1x2: r1 ? { dom: r3(x3H, 2), nul: r3(x3D, 2), ext: r3(x3A, 2) } : null, imp1x2: r1 ? { dom: r3(r1.dom), nul: r3(r1.nul), ext: r3(r1.ext) } : null,
      valeur1x2: r1 ? { dom: value(pr.p_reg_h, r1.dom), nul: value(pr.p_tie, r1.nul), ext: value(pr.p_reg_a, r1.ext) } : null,
      valeur_ext: value(pA, mkt != null ? 1 - mkt : null), valeur_dom: value(pH, mkt),
      confiance: conf, logique: facts, repos: rest, b2b: [a, h].filter(t => rest[t] === 0), gardiens: goalies, h2h: h2hRows,
      lineups: L ? { status: 'probables', source: 'nhl.com', time: lineupInfo, away: { lines: L.away.lines, pairs: L.away.pairs, pp1: '', pp2: '', changes: '' }, home: { lines: L.home.lines, pairs: L.home.pairs, pp1: '', pp2: '', changes: '' }, rapport: L.statusReport } : { status: 'non disponibles' },
    };
    // Marché : cote d'ouverture (premier relevé) et mouvement depuis
    if (!started && mkt != null && !db.odds_open[g.id]) db.odds_open[g.id] = { mkt_h: r3(mkt, 4), quand: ctx.consulted };
    const open = db.odds_open[g.id];
    const move = !started && mkt != null && open ? mkt - open.mkt_h : null;
    const cv: any = covBy.get(`${a}@${h}`);
    const pubSide = cv ? (cv.public_dom >= cv.public_ext ? h : a) : null, pubPct = cv ? Math.max(cv.public_dom, cv.public_ext) : null;
    const lTot = cv ? cv.leaders_dom + cv.leaders_ext : 0;
    const leadSide = cv && lTot >= 6 && Math.abs(cv.leaders_dom - cv.leaders_ext) >= 3 ? (cv.leaders_dom > cv.leaders_ext ? h : a) : null;
    const moveSide = move != null && Math.abs(move) >= 0.02 ? (move > 0 ? h : a) : null;
    const rlmSide = pubSide && pubPct! >= 60 && moveSide && moveSide !== pubSide ? moveSide : null;
    game.parieurs = cv || open ? {
      public_ext: cv?.public_ext ?? null, public_dom: cv?.public_dom ?? null, over_pct: cv?.over_pct ?? null, total: cv?.total ?? null,
      leaders_ext: cv?.leaders_ext ?? null, leaders_dom: cv?.leaders_dom ?? null, leaders_over: cv?.leaders_over ?? null, leaders_under: cv?.leaders_under ?? null,
      leaders_pick: leadSide, url: cv?.url ?? null, ouverture_dom: open?.mkt_h ?? null, ouverture_quand: open?.quand ?? null, mouvement: r3(move), rlm: rlmSide,
    } : null;
    // Cerveau de parieur pro : avantage réel sur la cote, signaux concordants, mise raisonnable (Kelly fractionné)
    if (!started) {
      const sides = [{ ab: h, p: pH, imp: mkt, cote: mlH }, { ab: a, p: pA, imp: mkt != null ? 1 - mkt : null, cote: mlA }].filter(x => x.imp != null && x.cote);
      const best = sides.sort((x, y) => (y.p - y.imp!) - (x.p - x.imp!))[0];
      const notes: string[] = [];
      let verdict = 'Pas de cote : impossible de juger l’avantage', side: string | null = null, mise = 0;
      if (best) {
        const edge = best.p - best.imp!;
        notes.push(`${best.ab} : ${Math.round(best.p * 100)} % selon moi contre ${Math.round(best.imp! * 100)} % dans la cote (${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)} pts).`);
        if (leadSide) notes.push(leadSide === best.ab ? `Les leaders Covers penchent aussi pour ${best.ab} (${best.ab === h ? cv.leaders_dom : cv.leaders_ext} contre ${best.ab === h ? cv.leaders_ext : cv.leaders_dom}).` : `Les leaders Covers penchent pour ${leadSide} : signal contraire.`);
        if (pubSide && pubPct! >= 65) notes.push(`${pubPct} % du public sur ${pubSide}${pubSide === best.ab ? ' : pari populaire, la cote est souvent moins généreuse' : ''}.`);
        if (rlmSide) notes.push(`Mouvement inverse : la cote bouge vers ${rlmSide} alors que le public joue l'autre camp, signe d'argent sérieux sur ${rlmSide}.`);
        else if (moveSide) notes.push(`La cote a bougé de ${Math.abs(move! * 100).toFixed(1)} pts vers ${moveSide} depuis ${open.quand}.`);
        const k = (best.p * best.cote! - 1) / (best.cote! - 1);
        if (edge >= params.vthr && conf !== 'Faible' && !(leadSide && leadSide !== best.ab && rlmSide && rlmSide !== best.ab)) { verdict = 'Jouable'; side = best.ab; mise = clamp(k / 4, 0, 0.02); }
        else if (edge >= 0.02) verdict = 'Léger avantage : petite mise ou passer';
        else verdict = 'Pas d’avantage : passer';
      }
      if (mL) {
        let c = 0; for (let k = 0; k <= Math.floor(mL.line); k++) c += poisson(k, pr.lh + pr.la);
        game.ou = { line: mL.line, cote_over: r3(mL.dO, 2), cote_under: r3(mL.dU, 2), p_over: r3(1 - c), p_under: r3(c) };
      }
      game.pro = { verdict, side, mise_pct: r3(mise * 100, 1), cote: side ? (side === h ? r3(mlH, 2) : r3(mlA, 2)) : null, notes };
    }
    if (started) {
      startedIds.add(g.id);
      const frozen = db.predictions.find((p: any) => p.game_id === g.id && p.type === 'Vainqueur');
      if (frozen) { const pd = frozen.selection_abbr === h ? frozen.prob : 1 - frozen.prob; game.p_dom = pd; game.p_ext = r3(1 - pd); game.fige = true; }
    }
    // joueurs
    const players: any[] = [];
    for (const [ab, opp, tl, lamT, gfT, gfRawT] of [[a, h, L?.away, pr.la, ra.gf, ra.gfRaw], [h, a, L?.home, pr.lh, rh.gf, rh.gfRaw]] as const) {
      const teamF = lamT / gfT;
      // Désavantage numérique adverse : un joueur qui produit beaucoup en AN profite d'un adversaire qui tue mal les pénalités.
      const pkOf = (t: string) => { const c = ctx.sc[t], q = ctx.sp[t]; const n = c?.gamesPlayed || 0, w = n / (n + 20); return w * (c?.penaltyKillPct ?? 0.79) + (1 - w) * (q?.penaltyKillPct ?? 0.79); };
      const pkVals = Object.values(ctx.sp).map((t: any) => t.penaltyKillPct).filter((x: any) => x > 0);
      const pkLg = pkVals.length ? pkVals.reduce((a: number, b: number) => a + b, 0) / pkVals.length : 0.79;
      const pkOpp = pkOf(opp);
      const saOf = (t: string) => { const c = ctx.sc[t], q = ctx.sp[t]; const n = c?.gamesPlayed || 0, w = n / (n + 15); return w * (c?.shotsAgainstPerGame ?? 30) + (1 - w) * (q?.shotsAgainstPerGame ?? 30); };
      const saVals = Object.values(ctx.sp).map((t: any) => t.shotsAgainstPerGame).filter((x: any) => x > 0);
      const saLg = saVals.length ? saVals.reduce((a: number, b: number) => a + b, 0) / saVals.length : 30;
      const shotF = clamp(1 + 0.5 * (saOf(opp) / saLg - 1), 0.88, 1.12);
      const pkF = clamp(1 + 0.5 * ((1 - pkOpp) / (1 - pkLg) - 1), 0.85, 1.2);
      const r = rosters[ab] || {};
      const skaters = [...(r.forwards || []), ...(r.defensemen || [])];
      const profs = skaters.map((s: any) => {
        const c = ctx.skCur.get(s.id), p = ctx.skPrev.get(s.id);
        const isD = s.positionCode === 'D';
        const cg = c?.gamesPlayed || 0, pg = p?.gamesPlayed || 0;
        // Buts = volume de tirs (stable, se juge vite) x réussite au tir ramenée vers la moyenne (très bruitée).
        const s_rate = blendRate(cg, cg ? c.shots / cg : 0, pg, pg ? p.shots / pg : 0, 6, isD ? 1.3 : 2.0);
        const shPrior = isD ? 0.045 : 0.105, K = 120;
        const sh_true = ((c?.goals || 0) + (p?.goals || 0) + shPrior * K) / ((c?.shots || 0) + (p?.shots || 0) + K);
        const g_goals = blendRate(cg, cg ? c.goals / cg : 0, pg, pg ? p.goals / pg : 0, 10, isD ? 0.06 : 0.18);
        const g_rate = 0.75 * s_rate * sh_true + 0.25 * g_goals;
        // Passes : encore plus bruitées, régression plus forte.
        const a_rate = blendRate(cg, cg ? c.assists / cg : 0, pg, pg ? p.assists / pg : 0, 20, isD ? 0.24 : 0.27);
        const p_rate = g_rate + a_rate;
        const toi_sec = c?.timeOnIcePerGame || p?.timeOnIcePerGame || 0;
        const ppPts = (c?.ppPoints || 0) + (p?.ppPoints || 0), allPts = (c?.points || 0) + (p?.points || 0);
        const pp_share = allPts >= 10 ? ppPts / allPts : (isD ? 0.35 : 0.3);
        const pp_sec = ctx.toi.get(s.id)?.ppTimeOnIcePerGame || 0;
        const oc = ctx.onCur.get(s.id), op = ctx.onPrev.get(s.id);
        const onGF = (x: any) => x ? (x.evenStrengthGoalsFor || 0) + (x.powerPlayGoalFor || 0) + (x.shortHandedGoalsFor || 0) : 0;
        const ocg = oc?.gamesPlayed || 0, opg = op?.gamesPlayed || 0;
        const onTot = onGF(oc) + onGF(op);
        // IPP : part des buts marqués avec lui sur la glace où il obtient un point (stable, ramenée vers la moyenne du poste)
        const ipp = (((c?.points || 0) + (p?.points || 0)) + (isD ? 0.42 : 0.68) * 30) / (onTot + 30);
        const priorOn = ctx.league * Math.min(0.6, (toi_sec || (isD ? 1200 : 900)) / 3600);
        const onPg = blendRate(ocg, ocg ? onGF(oc) / ocg : 0, opg, opg ? onGF(op) / opg : 0, 10, priorOn);
        const nom = `${nm(s.firstName)} ${nm(s.lastName)}`;
        return { id: s.id, nom, equipe: ab, adversaire: opp, pos: s.positionCode, mj: cg, buts: c?.goals || 0, passes: c?.assists || 0, points: c?.points || 0, tirs: c?.shots || 0,
          pct_tirs: c?.shootingPct != null ? r3(c.shootingPct * 100, 1) : null, buts_match: cg ? r3(c.goals / cg, 2) : null, pts_match: cg ? r3(c.points / cg, 2) : null,
          prev_mj: pg, prev_buts_match: pg ? r3(p.goals / pg, 2) : null, prev_pts_match: pg ? r3(p.points / pg, 2) : null,
          toi: fmtSec(c?.timeOnIcePerGame), toi_an: fmtSec(ctx.toi.get(s.id)?.ppTimeOnIcePerGame), g_rate, a_rate, p_rate, s_rate, sh_true, toi_sec, pp_share, pp_sec, ipp, onPg };
      });
      const cands = profs.filter(p => {
        const injd = inj.find(i => i.team === ab && nameMatch(p.nom, i.player));
        if (injd?.status === 'Confirmé absent') return false;
        if (tl && !isInLineup(tl, p.nom)) return false;
        return true;
      }).sort((x, y) => y.p_rate - x.p_rate);
      cands.forEach((p: any, i: number) => { p.top5 = i < 5; });
      await pool(cands, 8, async (p: any) => enrichLogs(ctx, p, opp));
      const ppm = (p: any) => 1 + (p.pp_share || 0) * (pkF - 1);
      // Points via la glace : buts attendus de l'équipe ce soir x sa part des buts sur la glace x son IPP.
      const lamIpp = (p: any) => (lamT / params.xg) * Math.min(0.75, p.onPg / Math.max(1.5, gfRawT)) * p.ipp * ppm(p) * (p.toi_eff && p.toi_sec ? clamp(Math.sqrt(p.toi_eff / p.toi_sec), 0.85, 1.12) : 1);
      const lamOld = (p: any) => p.p_rate * teamF / params.xg * ppm(p);
      const lamPts = (p: any) => (1 - params.wi) * lamOld(p) + params.wi * lamIpp(p);
      const CAL = (params as any).calib || {};
      const lamShots = (p: any) => (p.s_rate || 0) * shotF * Math.sqrt((p.toi_eff || p.toi_sec || 1) / (p.toi_sec || p.toi_eff || 1)) * params.as;
      // Régularité : certains joueurs étalent leurs points (un par match), d'autres les groupent. On compare la fréquence réelle
      // de matchs avec point (30 derniers) à ce que son rythme prédit, avec forte prudence (rappel vers 1, borne ±10 %).
      const regular = (p: any, prob: number) => {
        if (!(p.freq_n >= 10)) return prob;
        const avgM = pNB(p.p_rate * params.ap, params.rp);
        const w = p.freq_n / (p.freq_n + 40);
        const f = clamp(1 + w * (p.freq_pts / Math.max(0.05, avgM) - 1), 0.9, 1.1);
        p.reg_f = r3(f, 3);
        return Math.min(0.95, prob * f);
      };
      for (const p of cands) {
        const injd = inj.find(i => i.team === ab && nameMatch(p.nom, i.player));
        Object.assign(p, {
          game_id: g.id, match: `${a} @ ${h}`, statut: injd?.status || (tl ? 'Confirmé présent (projection nhl.com)' : 'Non confirmé'),
          ligne: lineSlot(tl, p.nom) || 'non disponible', unite_an: 'non disponible',
          // Les points arrivent par paquets (soirs à 3 points, soirs à 0) : la loi de Poisson surestime « au moins 1 ».
          // Facteurs de dispersion fixes ; les échelles apprises (ag, aa, ap) affinent ensuite sur les résultats réels.
          // Dispersion apprise sur les résultats réels : les points arrivent par paquets (soirs à 3 points, soirs à 0).
          lam_but: p.g_rate * teamF / params.xg * ppm(p), lam_passe: p.a_rate * teamF / params.xg * ppm(p), lam_point: lamPts(p), lam_old: lamOld(p), lam_ipp: lamIpp(p), xg_team: r3(lamT, 2), ipp_pct: r3(p.ipp * 100, 0), part_glace: r3(100 * Math.min(0.75, p.onPg / Math.max(1.5, gfRawT)), 0),
          p_but: r3(Math.min(0.6, calibrate(CAL.but, pNB(p.g_rate * teamF / params.xg * ppm(p) * params.ag * (p.pos === 'D' ? params.gD : 1), params.rg)))), p_passe: r3(pNB(p.a_rate * teamF / params.xg * ppm(p) * params.aa * (p.pos === 'D' ? params.aD : 1), params.ra)),
          // Plafond de réalisme : aucun joueur de NHL ne fait un point dans plus d'environ 85 % de ses matchs sur une saison.
          p_point: r3(Math.min(0.85, calibrate(CAL.point, regular(p, pNB(lamPts(p) * params.ap * (p.pos === 'D' ? params.pD : 1), params.rp))))),
          pk_adv: r3(pkOpp * 100, 1), an_sec: Math.round(p.pp_sec || 0),
          tirs_ce_soir: r3(lamShots(p), 2),
          p_tirs2: r3(calibrate(CAL.tirs2, pAtLeastK(lamShots(p), 2, params.rs))),
          p_tirs3: r3(calibrate(CAL.tirs3, pAtLeastK(lamShots(p), 3, params.rs))),
          // 2 points ou plus : recalé sur 208 sélections notées (annoncé 41 % pour 34 % réels) → échelle 0,9 et dispersion plus forte (paquets de points)
          p_point2: r3(pAtLeastK(lamPts(p) * params.ap * 0.9, 2, Math.min(params.rp, 2))),
          p_but2: r3(pAtLeastK(p.g_rate * teamF / params.xg * ppm(p) * params.ag, 2, Math.min(params.rg, 4))),   // doublés : dispersion plus forte mesurée sur les feuilles de match
          tirs_concedes_adv: r3(saOf(opp), 1),
          cote_but: null, cote_point: null, imp_but: null, imp_point: null, valeur_but: null, valeur_point: null,
          logique: `Taux pondéré ${p.g_rate.toFixed(2)} B/M, ${p.a_rate.toFixed(2)} A/M, ${p.p_rate.toFixed(2)} PTS/M (saison + précédente), ajusté par l'attendu offensif de ${ab} ce soir (x${teamF.toFixed(2)} : défense et gardien de ${opp}, domicile, calendrier), par l'avantage numérique (${Math.round((p.pp_share || 0) * 100)} % de ses points, ${opp} tue ${(pkOpp * 100).toFixed(0)} % des pénalités) et par les échelles apprises.`,
        });
        p.tirs_match_attendus = r3(p.s_rate, 2); p.reussite_attendue = r3(p.sh_true * 100, 1);
        for (const k of ['g_rate', 'a_rate', 'p_rate', 's_rate', 'sh_true']) p[k] = r3(p[k]);
        players.push(p);
      }
    }
    return { game, players, inj, feat, pr, mlA, mlH, x3: r1 ? { x3H, x3D, x3A } : null };
  });

  for (const { game, players, inj, feat, mlA, mlH, x3 } of perGame) {
    outGames.push(game); outPlayers.push(...players); injuries.push(...inj);
    const bt = bttsProbs(game.buts_attendus_dom, game.buts_attendus_ext, (params as any).btts);
    game.btts = { p: bt.map(x => r3(x.p)), dom: bt.map(x => r3(x.dom)), ext: bt.map(x => r3(x.ext)) };
    if (startedIds.has(game.game_id)) continue;
    const m = `${game.exterieur} @ ${game.domicile}`;
    const favH = game.p_dom >= game.p_ext;
    const sel = favH ? game.domicile : game.exterieur;
    const base = { v: 2, date: today, etape: MODE_LABEL[mode as 'update'], game_id: game.game_id, match: m, domicile: game.domicile, exterieur: game.exterieur, confiance: game.confiance, resultat: null, consulte: ctx.consulted };
    newPreds.push({ ...base, type: 'Vainqueur', selection: sel, selection_abbr: sel, prob: favH ? game.p_dom : game.p_ext, cote: favH ? game.cote_dom : game.cote_ext,
      prob_implicite: favH ? game.imp_dom : game.imp_ext, valeur: favH ? game.valeur_dom : game.valeur_ext, feat,
      gardiens_prevus: { ext: game.gardiens[game.exterieur].stats ? game.gardiens[game.exterieur].nom : null, dom: game.gardiens[game.domicile].stats ? game.gardiens[game.domicile].nom : null },
      gardiens_ok: !!(game.gardiens[game.exterieur].stats && game.gardiens[game.domicile].stats), xg_dom: game.buts_attendus_dom, xg_ext: game.buts_attendus_ext, xg_scale: params.xg, xgm_dom: game.xgm_dom, xgm_ext: game.xgm_ext, xgk_dom: feat.mkt_lh ?? null, xgk_ext: feat.mkt_la ?? null });
    for (const pl of players.filter((x: any) => x.top5)) for (const [typ, pk, lk] of [['But joueur', 'p_but', 'lam_but'], ['Passe joueur', 'p_passe', 'lam_passe'], ['Point joueur', 'p_point', 'lam_point']] as const) {
      newPreds.push({ ...base, type: typ, selection: pl.nom, player_id: pl.id, pos: pl.pos, ligne: pl.ligne, prob: pl[pk], lam_base: r3(pl[lk], 4), ...(typ === 'Point joueur' ? { lam_old: r3(pl.lam_old, 4), lam_ipp: r3(pl.lam_ipp, 4) } : {}), cote: null, prob_implicite: null, valeur: null, equipe: pl.equipe, s_exp: pl.s_rate, toi_exp: Math.round(pl.toi_eff || pl.toi_sec || 0), xg_team: pl.xg_team });
    }
    if (mlA) for (const [abbr, c] of [[game.exterieur, mlA], [game.domicile, mlH]] as const) newOdds.push({ date: today, match: m, marche: 'Vainqueur (prolongation incluse)', selection: abbr, cote: r3(c, 2), prob_implicite: r3(1 / c!), source: game.source_cotes, heure: game.heure_cotes });
    if (x3) for (const [lab, c] of [[game.domicile, x3.x3H], ['Nul (60 min)', x3.x3D], [game.exterieur, x3.x3A]] as const) newOdds.push({ date: today, match: m, marche: '1X2 temps réglementaire', selection: lab, cote: r3(c, 2), prob_implicite: r3(1 / c!), source: game.source_cotes, heure: game.heure_cotes });
  }
  const selection = buildSelection(outGames, outPlayers, startedIds, signalBilan(db));
  selection.btts = bttsSelection(outGames, startedIds, db);
  const sbase = (gid: number) => { const g = outGames.find(x => x.game_id === gid); return { date: today, etape: MODE_LABEL[mode as 'update'], game_id: gid, match: `${g.exterieur} @ ${g.domicile}`, domicile: g.domicile, exterieur: g.exterieur, confiance: g.confiance, resultat: null, consulte: ctx.consulted, cote: null, prob_implicite: null, valeur: null }; };
  for (const t of selection.equipes) newPreds.push({ ...sbase(t.game_id), type: 'Sélection équipe', selection: t.equipe, selection_abbr: t.equipe, prob: t.prob, cote: t.cote, prob_implicite: t.imp });
  for (const [list, typ] of [[selection.buts, 'Sélection but'], [selection.points, 'Sélection point']] as const) for (const p of list) newPreds.push({ ...sbase(p.game_id), type: typ, selection: p.nom, player_id: p.id, pos: p.pos, ligne: p.ligne, prob: p.prob, niveau: p.niveau });
  for (const [list, typ] of [[selection.deux_points, 'Sélection 2+ points'], [selection.deux_buts, 'Sélection 2+ buts']] as const) for (const p of list) newPreds.push({ ...sbase(p.game_id), v: 2, type: typ, selection: p.nom, player_id: p.id, pos: p.pos, prob: p.prob });
  // lecture pro « Jouable » et signaux extérieurs du soir
  db.signals = db.signals || [];
  for (const g of outGames) {
    if (startedIds.has(g.game_id)) continue;
    if (g.pro?.verdict === 'Jouable') { const pd = g.pro.side === g.domicile ? g.p_dom : g.p_ext; newPreds.push({ ...sbase(g.game_id), v: 2, type: 'Lecture pro', selection: g.pro.side, selection_abbr: g.pro.side, prob: pd, cote: g.pro.cote, prob_implicite: g.pro.cote ? r3(1 / g.pro.cote) : null, valeur: 'Valeur potentielle', mise_pct: g.pro.mise_pct }); }
    const pr = g.parieurs || {};
    const pub = pr.public_dom != null ? (pr.public_dom >= pr.public_ext ? g.domicile : g.exterieur) : null;
    const lo = pr.leaders_over, lu2 = pr.leaders_under;
    db.signals = db.signals.filter((x: any) => !(x.game_id === g.game_id && x.res == null)).concat([{ date: today, game_id: g.game_id, dom: g.domicile, ext: g.exterieur,
      picks: { modele: g.p_dom >= g.p_ext ? g.domicile : g.exterieur, public: pub, leaders: pr.leaders_pick ?? null, mouvement_inverse: pr.rlm ?? null, pro: g.pro?.side ?? null },
      ou: pr.total != null ? { line: pr.total, public: pr.over_pct != null ? (pr.over_pct >= 50 ? 'over' : 'under') : null, leaders: lo != null && lo + lu2 >= 6 && Math.abs(lo - lu2) >= 3 ? (lo > lu2 ? 'over' : 'under') : null } : null, res: null }]);
  }
  // ---- 2 paris d'autres parieurs (Covers), avec mon avis et la vérification de leur historique
  const fr = (p: any) => p.kind === 'win' ? `${p.team} gagne (cote ${p.cote ? p.cote.toFixed(2) : '?'})` : `${p.kind === 'over' ? 'Plus' : 'Moins'} de ${p.line} buts`;
  const autres: any[] = [];
  for (const b of tb.parieurs) {
    if (autres.length === 2) break;
    const mine = tb.paris.filter((p: any) => p.parieur.nom === b.nom && p.kind !== 'spread').map((p: any) => {
      const g = outGames.find(x => x.exterieur === p.away && x.domicile === p.home);
      if (!g || startedIds.has(g.game_id)) return null;
      const notre = p.kind === 'win' ? (p.team === g.domicile ? g.p_dom : g.p_ext) : g.ou && g.ou.line === p.line ? (p.kind === 'over' ? g.ou.p_over : g.ou.p_under) : null;
      return { p, g, notre };
    }).filter(Boolean) as any[];
    if (!mine.length) continue;
    const pick = mine.sort((x, y) => (y.notre ?? 0) - (x.notre ?? 0))[0];
    const ev = pick.notre != null && pick.p.cote ? pick.notre * pick.p.cote - 1 : null;
    const pc = pick.notre != null ? Math.round(pick.notre * 100) : null;
    autres.push({ game_id: pick.g.game_id, match: `${pick.g.exterieur} @ ${pick.g.domicile}`, pari: fr(pick.p), kind: pick.p.kind, team: pick.p.team, line: pick.p.line, cote: pick.p.cote ? r3(pick.p.cote, 2) : null,
      parieur: { nom: b.nom, url: b.url, record: `${b.gagnes}-${b.perdus}`, taux: r3(b.taux), borne_basse: r3(b.borne_basse), z: r3(b.z, 2), au_dela_chance: b.z >= tb.seuil_chance },
      notre: pick.notre != null ? r3(pick.notre) : null, ev: ev != null ? r3(ev) : null,
      avis: pc == null ? "Je n'ai pas d'estimation sur ce pari." : pc >= 50 ? (ev != null && ev < 0 ? `Je suis d'accord sur le fond (${pc} %) mais la cote est un peu courte.` : `Je suis d'accord : ${pc} % selon moi.`) : `Je ne suis pas d'accord : ${pc} % selon moi.` });
  }
  selection.autres = { paris: autres, n_classes: tb.n_classes, seuil_chance: r3(tb.seuil_chance, 2) };
  // ---- Les 5 meilleurs parieurs Covers : classement, chance ou talent, leurs paris du soir avec mon avis, et leur bilan mesuré par moi
  const avisOf = (notre: number | null, ev: number | null) => { const pc = notre != null ? Math.round(notre * 100) : null; return pc == null ? "Je n'ai pas d'estimation sur ce pari." : pc >= 50 ? (ev != null && ev < 0 ? `D'accord sur le fond (${pc} %) mais la cote est un peu courte.` : `Je suis d'accord : ${pc} % selon moi.`) : `Je ne suis pas d'accord : ${pc} % selon moi.`; };
  const top5 = tb.parieurs.slice(0, 5).map((b: any, i: number) => {
    const paris = tb.paris.filter((p: any) => p.parieur.nom === b.nom && p.kind !== 'spread').map((p: any) => {
      const g = outGames.find(x => x.exterieur === p.away && x.domicile === p.home);
      if (!g) return null;
      const notre = p.kind === 'win' ? (p.team === g.domicile ? g.p_dom : g.p_ext) : g.ou && g.ou.line === p.line ? (p.kind === 'over' ? g.ou.p_over : g.ou.p_under) : null;
      const ev = notre != null && p.cote ? notre * p.cote - 1 : null;
      return { game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, pari: fr(p), kind: p.kind, team: p.team, line: p.line, cote: p.cote ? r3(p.cote, 2) : null, notre: r3(notre), ev: r3(ev), avis: avisOf(notre, ev), commence: startedIds.has(g.game_id) };
    }).filter(Boolean);
    const me = db.predictions.filter((p: any) => p.type === 'Pari top Covers' && p.parieur === b.nom && (p.resultat === 0 || p.resultat === 1));
    return { rang: i + 1, nom: b.nom, url: b.url, record: `${b.gagnes}-${b.perdus}`, taux: r3(b.taux), unites: b.unites, borne_basse: r3(b.borne_basse), z: r3(b.z, 2), au_dela_chance: b.z >= tb.seuil_chance,
      paris, mesure: { n: me.length, gagnes: me.filter((p: any) => p.resultat === 1).length } };
  });
  selection.top5 = { parieurs: top5, n_classes: tb.n_classes, seuil_chance: r3(tb.seuil_chance, 2) };
  const GAMES = outGames, STARTED = startedIds, UNIT = 'buts';
  // probabilité d'une jambe OLBG : vainqueur (prolongation incluse), handicap et total sur le score final (prolongation et tirs au but = 1 but de plus)
  const LEGP = (g: any, l: any) => {
    if (!l) return null;
    if (l.kind === 'win') return l.team === g.domicile ? g.p_dom : g.p_ext;
    const lh = g.buts_attendus_dom, la = g.buts_attendus_ext, wDom = g.p_dom >= g.p_ext ? 0.55 : 0.45;
    let p = 0;
    for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
      const q = poisson(i, lh) * poisson(j, la);
      if (l.kind === 'over' || l.kind === 'under') { const t = i + j + (i === j ? 1 : 0); if (l.kind === 'over' ? t > l.line : t < l.line) p += q; continue; }
      const sgn = l.team === g.domicile ? 1 : -1, m = sgn * (i - j);
      if (m !== 0) { if (m + l.line > 0) p += q; }
      else { const wT = l.team === g.domicile ? wDom : 1 - wDom; p += q * (wT * +(1 + l.line > 0) + (1 - wT) * +(-1 + l.line > 0)); }
    }
    return Math.min(0.98, Math.max(0.02, p));
  };
  // ---- OLBG : consensus des tipsters et pari du meilleur tipster de chaque match, avec mon avis
  const olbgAvis = (notre: number | null, ev: number | null) => { const pc = notre != null ? Math.round(notre * 100) : null; return pc == null ? "Je n'ai pas d'estimation sur ce pari." : pc >= 50 ? (ev != null && ev < 0 ? `D'accord sur le fond (${pc} %) mais la cote est un peu courte.` : `Je suis d'accord : ${pc} % selon moi.`) : `Je ne suis pas d'accord : ${pc} % selon moi.`; };
  const olbgMatchs = (OL.games || []).map((o: any) => {
    const g = GAMES.find((x: any) => x.exterieur === o.ext && x.domicile === o.dom); if (!g) return null;
    const cote = (l: any) => l?.kind === 'win' ? (l.team === g.domicile ? g.cote_dom : g.cote_ext) : null;
    const enrich = (c: any) => { const notre = LEGP(g, c.leg), ct = cote(c.leg), ev = notre != null && ct ? notre * ct - 1 : null; return { ...c, label: legLabel(c.leg, c.selection, UNIT), notre: r3(notre), cote: r3(ct, 2), ev: r3(ev), avis: olbgAvis(notre, ev) }; };
    const cons = o.consensus.filter((c: any) => c.leg && c.total >= 2).map(enrich);
    const pop = [...cons].sort((a: any, b: any) => b.n - a.n || b.pct - a.pct)[0] || null;
    return { game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, url: o.url, commence: STARTED.has(g.game_id), consensus: cons, populaire: pop, best: o.best && o.best.leg ? enrich(o.best) : null, n_tips: o.tips.length };
  }).filter(Boolean) as any[];
  const olbgTop = olbgMatchs.filter((m: any) => !m.commence).flatMap((m: any) => m.consensus.filter((c: any) => c.total >= 5 && c.pct >= 0.7).map((c: any) => ({ ...c, game_id: m.game_id, match: m.match })))
    .sort((a: any, b: any) => (b.notre ?? 0) - (a.notre ?? 0) || b.n - a.n).slice(0, 5);
  const olbg = { ok: OL.ok, raison: OL.reason || '', matchs: olbgMatchs, top: olbgTop };
  selection.olbg = olbg;
  for (const c of olbgTop) newPreds.push({ ...sbase(c.game_id), v: 2, type: 'Consensus OLBG', selection: `${c.label} (${c.n}/${c.total} tipsters)`, legs: [{ kind: c.leg.kind, team: c.leg.team, line: c.leg.line, game_id: c.game_id }], prob: c.notre ?? 0.5, cote: c.cote });
  for (const m of olbgMatchs) if (!m.commence && m.best) newPreds.push({ ...sbase(m.game_id), v: 2, type: 'Pari tipster OLBG', parieur: m.best.tipster, selection: `${m.best.tipster} : ${m.best.label}`, legs: [{ kind: m.best.leg.kind, team: m.best.leg.team, line: m.best.leg.line, game_id: m.game_id }], prob: m.best.notre ?? 0.5, cote: m.best.cote });
  for (const b of top5) for (const a of b.paris as any[]) if (!a.commence) newPreds.push({ ...sbase(a.game_id), v: 2, type: 'Pari top Covers', parieur: b.nom, selection: `${b.nom} : ${a.pari}`, legs: [{ kind: a.kind, team: a.team, line: a.line, game_id: a.game_id }], prob: a.notre ?? 0.5, cote: a.cote });
  selection.buteur = buteurDuSoir(ctx, outGames, outPlayers, startedIds, lu.games, db);
  if (selection.buteur) { const bt = selection.buteur; newPreds.push({ ...sbase(bt.game_id), v: 2, type: 'Buteur du soir', selection: bt.nom, player_id: bt.id, pos: bt.pos, prob: bt.p_but, cote: null }); }
  for (const a of autres) newPreds.push({ ...sbase(a.game_id), v: 2, type: 'Pari parieur Covers', selection: `${a.parieur.nom} : ${a.pari}`, legs: [{ kind: a.kind, team: a.team, line: a.line, game_id: a.game_id }], prob: a.notre ?? 0.5, cote: a.cote });
  for (const c of selection.cote2) newPreds.push({ ...sbase(c.game_id), v: 2, type: 'Cote 2+', selection: c.label, legs: [{ kind: c.kind, team: c.team, line: c.line, game_id: c.game_id, label: c.label, match: c.match }], prob: c.prob, cote: c.cote, prob_implicite: r3(1 / c.cote), valeur: 'Valeur potentielle' });
  if (selection.safe) newPreds.push({ ...sbase(selection.safe.legs[0].game_id), v: 2, type: 'Pari safe du jour', selection: selection.safe.legs.map((l: any) => l.label).join(' + '), legs: selection.safe.legs.map((l: any) => ({ kind: l.kind, team: l.team, player_id: l.player_id, game_id: l.game_id, label: l.label, match: l.match, cote: l.cote })), prob: selection.safe.prob, cote: selection.safe.cote });
  for (const f of selection.fun) newPreds.push({ ...sbase(f.legs[0].game_id), v: 2, type: `Pari fun ${f.theme}`, selection: f.legs.map((l: any) => l.label).join(' + '), legs: f.legs.map((l: any) => ({ kind: l.kind, team: l.team, line: l.line, player_id: l.player_id, game_id: l.game_id, label: l.label, match: l.match, cote: l.cote })), prob: f.prob, cote: f.cote });
  for (const t of selection.tirs) newPreds.push({ ...sbase(t.game_id), type: `Sélection tirs ${t.seuil}+`, selection: t.nom, player_id: t.id, pos: t.pos, prob: t.prob });
  if (selection.combines[0]) { const c = selection.combines[0]; newPreds.push({ ...sbase(c.joueurs[0].game_id), type: 'Combiné point', selection: c.joueurs.map((j: any) => j.nom).join(' + '), legs: c.joueurs.map((j: any) => ({ game_id: j.game_id, player_id: j.id })), prob: c.prob }); }
  for (const g of outGames) if (!startedIds.has(g.game_id) && g.btts) newPreds.push({ ...sbase(g.game_id), v: 2, type: 'Deux marquent', selection: 'Les deux équipes marquent (60 min)', prob: g.btts.p[0], segs: g.btts.p, xg_dom: g.buts_attendus_dom, xg_ext: g.buts_attendus_ext });
  if (selection.btts.match) { const m = selection.btts.match; newPreds.push({ ...sbase(m.game_id), v: 2, type: 'Deux marquent : match le plus sûr', selection: `${m.match} : les deux marquent (60 min)`, prob: m.prob, periode: 0 }); }
  if (selection.btts.periode) { const m = selection.btts.periode; newPreds.push({ ...sbase(m.game_id), v: 2, type: 'Deux marquent : période la plus sûre', selection: `${m.match} : les deux marquent en ${m.label}`, prob: m.prob, periode: m.k }); }
  selection.bilan = bilanSelection(db);
  // remplace les prédictions non évaluées des matchs pas encore commencés
  const replaced = new Set(newPreds.map(p => p.game_id));
  db.predictions = db.predictions.filter((p: any) => !(replaced.has(p.game_id) && p.resultat == null)).concat(newPreds);
  db.odds = db.odds.filter((o: any) => !(o.date === today && newOdds.some(n => n.match === o.match))).concat(newOdds);
  db.players = db.players.filter((x: any) => x.date !== today).concat(outPlayers.map(p => { const { logique, lam_but, lam_passe, lam_point, ...rest } = p; return { ...rest, date: today, source: 'nhl.com', consulte: ctx.consulted }; }));
  if (injuries.length) db.injuries = db.injuries.filter((x: any) => x.date !== today).concat(injuries.map(i => ({ ...i, date: today, consulte: ctx.consulted })));
  for (const p of outPlayers) { delete p.lam_but; delete p.lam_passe; delete p.lam_point; }
  return { games: outGames, players: outPlayers, injuries, lineupInfo, oddsInfo, selection, coversInfo, olbgInfo };
}

function bilanSelection(db: any) {
  const out: any = {};
  for (const [k, typ] of [['point', 'Sélection point'], ['but', 'Sélection but'], ['equipe', 'Sélection équipe'], ['tirs', 'Sélection tirs'], ['combine', 'Combiné point'], ['deux_points', 'Sélection 2+'], ['pro', 'Lecture pro'], ['cote2', 'Cote 2+'], ['fun', 'Pari fun'], ['autres', 'Pari parieur Covers'], ['top5', 'Pari top Covers'], ['olbg_top', 'Consensus OLBG'], ['olbg_best', 'Pari tipster OLBG'], ['buteur', 'Buteur du soir'], ['safe', 'Pari safe du jour'], ['btts_match', 'Deux marquent : match'], ['btts_periode', 'Deux marquent : période']] as const) {
    const g = db.predictions.filter((p: any) => p.type.startsWith(typ) && (p.resultat === 0 || p.resultat === 1));
    const sur = g.filter((p: any) => p.niveau === 'Choix sûr');
    out[k] = { n: g.length, gagnes: g.filter((p: any) => p.resultat === 1).length, sur_n: sur.length, sur_gagnes: sur.filter((p: any) => p.resultat === 1).length };
  }
  return out;
}

// ------------------------------------------------------------------ « Les deux équipes marquent »
const PER_LAB = ['match entier', '1re période', '2e période', '3e période'];
function bttsSelection(games: any[], started: Set<number>, db: any) {
  const liste = games.filter(g => g.btts).map(g => {
    const k = [1, 2, 3].sort((x, y) => g.btts.p[y] - g.btts.p[x])[0];
    return { game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, ext: g.exterieur, dom: g.domicile, heure: g.debut_paris ?? null, commence: started.has(g.game_id),
      xg_dom: g.buts_attendus_dom, xg_ext: g.buts_attendus_ext, total: r3(g.buts_attendus_dom + g.buts_attendus_ext, 2), p: g.btts.p, dom_marque: g.btts.dom, ext_marque: g.btts.ext,
      meilleure: k, gardiens: [g.gardiens?.[g.exterieur]?.nom ?? null, g.gardiens?.[g.domicile]?.nom ?? null] };
  }).sort((x, y) => y.p[0] - x.p[0]);
  const open = liste.filter(x => !x.commence);
  const why = (x: any, k: number) => {
    const w = [`Buts attendus : ${x.ext} ${x.xg_ext} – ${x.dom} ${x.xg_dom} (total ${x.total}).`,
      `${k ? `En ${PER_LAB[k]}, ` : ''}${x.ext} marque ${Math.round(x.ext_marque[k] * 100)} % du temps, ${x.dom} ${Math.round(x.dom_marque[k] * 100)} % (hasard pur), recalé sur les vrais scores NHL.`];
    if (k === 3) w.push('La 3e période est la plus prolifique : l’équipe menée pousse et sort son gardien en fin de match.');
    const lo = Math.min(x.xg_dom, x.xg_ext);
    w.push(lo >= 2.9 ? `Aucune des deux attaques n’est faible : la moins productive attend encore ${lo} buts.` : `Point faible : ${x.xg_dom < x.xg_ext ? x.dom : x.ext} n’attend que ${lo} buts, c’est elle qui peut rester muette.`);
    return w;
  };
  const best = open[0];
  const match = best ? { game_id: best.game_id, match: best.match, prob: best.p[0], cote_juste: r3(1 / best.p[0], 2), cote_min: r3(1.05 / best.p[0], 2), raisons: why(best, 0) } : null;
  const per = open.flatMap(x => [1, 2, 3].map(k => ({ x, k, p: x.p[k] }))).sort((a, b) => b.p - a.p)[0];
  const periode = per ? { game_id: per.x.game_id, match: per.x.match, k: per.k, label: PER_LAB[per.k], prob: per.p, cote_juste: r3(1 / per.p, 2), cote_min: r3(1.05 / per.p, 2), raisons: why(per.x, per.k) } : null;
  // fiabilité mesurée : prévu contre réel pour chaque segment, sur toutes les prévisions notées
  const g = (db.predictions || []).filter((p: any) => p.type === 'Deux marquent' && Array.isArray(p.res_seg));
  const fiab = [0, 1, 2, 3].map(k => ({ k, label: PER_LAB[k], n: g.length, prevu: g.length ? r3(g.reduce((s: number, p: any) => s + p.segs[k], 0) / g.length) : null, reel: g.length ? r3(g.reduce((s: number, p: any) => s + p.res_seg[k], 0) / g.length) : null }));
  return { liste, match, periode, fiab, backtest: { soirees: 28, match: [27, 28], periode: [14, 28], prevu_periode: 0.49 } };
}

// ------------------------------------------------------------------ sélection du soir (5 joueurs point, 5 buteurs, équipes)
function buildSelection(games: any[], players: any[], started: Set<number>, signaux: any[] = []) {
  const gById = new Map(games.map(g => [g.game_id, g]));
  const confW: Record<string, number> = { 'Élevée': 30, 'Moyenne': 20, 'Faible': 10 };
  const eligible = players.filter(p => {
    const g = gById.get(p.game_id);
    if (!g || started.has(p.game_id)) return false;
    if (/absent|incertain/i.test(p.statut)) return false;
    if ((p.mj || 0) + (p.prev_mj || 0) < 25) return false;                          // trop peu de matchs pour juger
    if (p.toi_sec && p.toi_sec < (p.pos === 'D' ? 18 * 60 : 14 * 60)) return false;  // rôle trop limité
    return true;
  }).map(p => {
    const g = gById.get(p.game_id);
    const opp = p.equipe === g.domicile ? g.exterieur : g.domicile;
    const lineTop = /^(L1|L2|P1)$/.test(p.ligne);
    const fiab = Math.round(Math.min(1, ((p.mj || 0) + (p.prev_mj || 0)) / 70) * 35 + (lineTop ? 25 : p.ligne !== 'non disponible' ? 12 : 0)
      + (g.gardiens?.[opp]?.stats ? 10 : 0) + (confW[g.confiance] || 10));
    return { ...p, fiabilite: fiab, opp };
  }).filter(p => p.fiabilite >= 40);

  // « Choix sûr » : critères qui ont le mieux réussi sur l'historique (forte probabilité + vrai rôle en avantage numérique
  // + gros temps de glace). Au plus 3, un seul par équipe ; les compléments viennent ensuite.
  const strict = (p: any, key: string) => key === 'p_point'
    ? p.p_point >= 0.62 && p.pp_sec >= 150 && p.toi_sec >= (p.pos === 'D' ? 20 : 17) * 60 && (p.ligne === 'non disponible' || /^(L1|L2|P1)$/.test(p.ligne))
    : p.p_but >= 0.38 && p.pp_sec >= 150 && (p.s_rate || 0) >= 3;
  const pickTop = (key: 'p_point' | 'p_but') => {
    const out: any[] = []; const perTeam: Record<string, number> = {}; const perGame: Record<number, number> = {};
    const sorted = [...eligible].sort((a, b) => b[key] - a[key] || b.fiabilite - a.fiabilite);
    for (const p of sorted.filter(p => strict(p, key))) {
      if (perTeam[p.equipe] || (perGame[p.game_id] || 0) >= 2) continue;
      perTeam[p.equipe] = 1; perGame[p.game_id] = (perGame[p.game_id] || 0) + 1;
      out.push({ ...p, niveau: 'Choix sûr' }); if (out.length === 3) break;
    }
    for (const p of sorted) {
      if (out.length === 5) break;
      if (out.some(x => x.id === p.id)) continue;
      if ((perTeam[p.equipe] || 0) >= 2 || (perGame[p.game_id] || 0) >= 3) continue;   // diversifier : un match fermé ne doit pas tout faire tomber
      perTeam[p.equipe] = (perTeam[p.equipe] || 0) + 1; perGame[p.game_id] = (perGame[p.game_id] || 0) + 1;
      out.push({ ...p, niveau: 'Complément' });
    }
    return out.map(p => {
      const g = gById.get(p.game_id);
      const xg = p.equipe === g.domicile ? g.buts_attendus_dom : g.buts_attendus_ext;
      const gk = g.gardiens?.[p.opp];
      const why = [
        `${p.tirs_match_attendus ?? '?'} tirs attendus par match, réussite au tir de référence ${p.reussite_attendue ?? '?'} % (saison + précédente, ramenée vers la moyenne).`,
        `${p.toi || '?'} de temps de glace${p.toi_an ? `, dont ${p.toi_an} en avantage numérique` : ''}${p.ligne !== 'non disponible' ? `, ${p.ligne} selon nhl.com` : ''}.`,
        `${p.equipe} attend ${xg} buts ce soir contre ${p.opp}${gk?.stats ? ` (gardien ${gk.nom}, ${gk.stats.pct_arrets ?? gk.stats.prev_pct_arrets ?? 'n.d.'} d'arrêts)` : ''}.`,
      ];
      if (p.ipp_pct != null) why.push(`Sur la glace : il est présent sur ${p.part_glace} % des buts de son équipe et obtient un point sur ${p.ipp_pct} % de ceux-là.`);
      if (p.pp_sec) why.push(`Avantage numérique : ${fmtSec(p.pp_sec)} par match, ${Math.round((p.pp_share || 0) * 100)} % de ses points ; ${p.opp} tue ${p.pk_adv ?? '?'} % des pénalités.`);
      if (p.regularite) why.push(`${p.regularite}${p.reg_f && Math.abs(p.reg_f - 1) >= 0.02 ? ` : joueur ${p.reg_f > 1 ? 'régulier, léger bonus' : 'irrégulier (points groupés), léger malus'}` : ''}.`);
      if (p.lecture) why.push(p.lecture);
      return { p_tirs2: p.p_tirs2, p_tirs3: p.p_tirs3, niveau: p.niveau, id: p.id, nom: p.nom, equipe: p.equipe, opp: p.opp, pos: p.pos, ligne: p.ligne, game_id: p.game_id, match: p.match, prob: p[key], p_but: p.p_but, p_point: p.p_point, fiabilite: p.fiabilite, chance: p.chance ?? null, raisons: why };
    });
  };

  const equipes = games.filter(g => !started.has(g.game_id)).map(g => {
    const home = g.p_dom >= g.p_ext, team = home ? g.domicile : g.exterieur, opp = home ? g.exterieur : g.domicile;
    const prob = home ? g.p_dom : g.p_ext, mk = g.p_marche_dom == null ? null : (home ? g.p_marche_dom : 1 - g.p_marche_dom);
    const mod = g.p_modele_dom == null ? null : (home ? g.p_modele_dom : 1 - g.p_modele_dom);
    const score = prob * 100 + (mk != null && Math.abs(mod - mk) <= 0.05 ? 5 : 0) - (g.b2b.includes(team) ? 5 : 0) - (g.confiance === 'Faible' ? 8 : 0) - (!g.gardiens?.[team]?.stats ? 5 : 0);
    const notes: string[] = [];
    notes.push(`Probabilité retenue ${Math.round(prob * 100)} % (${home ? 'à domicile' : 'à l’extérieur'}), ${g.buts_attendus_dom}–${g.buts_attendus_ext} buts attendus (domicile–extérieur).`);
    if (mk != null) notes.push(Math.abs(mod - mk) <= 0.05 ? `Le marché est d'accord (${Math.round(mk * 100)} %) : signal plus solide.` : `Désaccord avec le marché (modèle seul ${Math.round(mod * 100)} %, marché ${Math.round(mk * 100)} %) : prudence.`);
    if (g.b2b.includes(team)) notes.push(`${team} joue son 2e match en 2 soirs.`);
    if (g.b2b.includes(opp)) notes.push(`${opp} joue son 2e match en 2 soirs (avantage ${team}).`);
    notes.push(g.gardiens?.[team]?.stats ? `Gardien ${team} : ${g.gardiens[team].nom} (${g.gardiens[team].statut}).` : `Gardien ${team} non connu : moins fiable.`);
    return { game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, equipe: team, adversaire: opp, prob, cote: home ? g.cote_dom : g.cote_ext, imp: home ? g.imp_dom : g.imp_ext, confiance: g.confiance, score, raisons: notes, solide: prob >= 0.6 && g.confiance !== 'Faible' };
  }).sort((a, b) => b.score - a.score).slice(0, 3);

  const live = players.filter(p => !started.has(p.game_id) && !/absent/i.test(p.statut) && p.chance != null && p.lecture);
  const brief = (p: any) => ({ nom: p.nom, equipe: p.equipe, match: p.match, chance: p.chance, p_but: p.p_but, p_point: p.p_point, lecture: p.lecture });
  const pieges = live.filter(p => p.chance >= 1.8).sort((a, b) => b.chance - a.chance).slice(0, 5).map(brief);
  const relance = live.filter(p => p.chance <= -1.5 && (p.l10_tirs_match || 0) >= 2.5).sort((a, b) => a.chance - b.chance).slice(0, 5).map(brief);
  // Objectif 80 % : les tirs cadrés d'un gros tireur sont bien plus prévisibles qu'un point.
  const tirs: any[] = []; const tTeam: Record<string, number> = {};
  const tc = eligible.flatMap((p: any) => [
    p.p_tirs3 >= 0.8 ? { p, seuil: 3, prob: p.p_tirs3 } : null,
    p.p_tirs2 >= 0.85 && !(p.p_tirs3 >= 0.8) ? { p, seuil: 2, prob: p.p_tirs2 } : null,
  ].filter(Boolean)).sort((a: any, b: any) => b.prob - a.prob);
  for (const { p, seuil, prob } of tc) {
    if (tTeam[p.equipe]) continue;
    tTeam[p.equipe] = 1;
    tirs.push({ id: p.id, nom: p.nom, equipe: p.equipe, opp: p.opp, pos: p.pos, game_id: p.game_id, match: p.match, seuil, prob,
      raisons: [`${p.tirs_ce_soir} tirs attendus ce soir (${p.tirs_match_attendus} en moyenne, ${p.l10_tirs_match ?? '?'} sur ses 10 derniers matchs).`,
        `${p.opp} concède ${p.tirs_concedes_adv} tirs par match ; temps de glace ${p.toi_recent || p.toi || '?'}${p.toi_an ? `, dont ${p.toi_an} en avantage numérique` : ''}.`,
        `Au moins ${seuil} tirs cadrés : ${Math.round(prob * 100)} %. Pour comparaison, au moins 1 point : ${Math.round((p.p_point || 0) * 100)} %.`] });
    if (tirs.length === 5) break;
  }

  // Combiné de 2 joueurs (au moins 1 point chacun), dans deux matchs différents pour rester indépendants.
  const ambitieux = (key: 'p_point2' | 'p_but2', n: number, lab: string) => {
    const out: any[] = []; const seen: Record<string, number> = {};
    for (const p of [...eligible].sort((x: any, y: any) => y[key] - x[key])) {
      if (seen[p.equipe]) continue; seen[p.equipe] = 1;
      out.push({ id: p.id, nom: p.nom, equipe: p.equipe, opp: p.opp, pos: p.pos, game_id: p.game_id, match: p.match, prob: p[key], cote_juste: r3(1 / Math.max(0.01, p[key]), 2), pari: lab,
        raisons: [`${lab} : ${Math.round(p[key] * 100)} % (cote juste ${(1 / Math.max(0.01, p[key])).toFixed(2)}). Au moins 1 point : ${Math.round(p.p_point * 100)} %.`,
          p.ipp_pct != null ? `Présent sur ${p.part_glace} % des buts de son équipe, point sur ${p.ipp_pct} % d'entre eux ; ${p.equipe} attend ${p.xg_team} buts.` : '',
          p.regularite || ''].filter(Boolean) });
      if (out.length === n) break;
    }
    return out;
  };
  const pts = pickTop('p_point');
  const pairs: any[] = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const x = pts[i], y = pts[j];
    if (x.game_id === y.game_id) continue;
    const p = x.prob * y.prob;
    pairs.push({ joueurs: [x, y].map(z => ({ id: z.id, nom: z.nom, equipe: z.equipe, opp: z.opp, game_id: z.game_id, match: z.match, prob: z.prob, niveau: z.niveau })),
      prob: r3(p), cote_juste: r3(1 / p, 2), deux_surs: x.niveau === 'Choix sûr' && y.niveau === 'Choix sûr' });
  }
  pairs.sort((a, b) => (b.deux_surs ? 1 : 0) - (a.deux_surs ? 1 : 0) || b.prob - a.prob);
  // ---- Réservoir de « jambes » : chaque pari simple possible ce soir, avec ma probabilité et sa cote (marché si connue)
  const legs: any[] = [];
  const liveG = games.filter(g => !started.has(g.game_id));
  for (const g of liveG) {
    const m = `${g.exterieur} @ ${g.domicile}`;
    if (g.cote_dom) legs.push({ kind: 'win', team: g.domicile, game_id: g.game_id, label: `${g.domicile} gagne (prolongation incluse)`, match: m, prob: g.p_dom, cote: g.cote_dom, marche: true });
    if (g.cote_ext) legs.push({ kind: 'win', team: g.exterieur, game_id: g.game_id, label: `${g.exterieur} gagne (prolongation incluse)`, match: m, prob: g.p_ext, cote: g.cote_ext, marche: true });
    // cotes pas encore publiées : on utilise la cote juste du favori, remplacée par la vraie cote à la PRÉ-MATCH
    if (!g.cote_dom && !g.cote_ext) { const fh = g.p_dom >= g.p_ext; legs.push({ kind: 'win', team: fh ? g.domicile : g.exterieur, game_id: g.game_id, label: `${fh ? g.domicile : g.exterieur} gagne (prolongation incluse)`, match: m, prob: Math.max(g.p_dom, g.p_ext), cote: r3(1 / Math.max(g.p_dom, g.p_ext), 2), marche: false }); }
    if (g.cote1x2) {
      legs.push({ kind: 'reg', team: g.domicile, game_id: g.game_id, label: `${g.domicile} gagne en 60 min`, match: m, prob: g.p_reg_dom, cote: g.cote1x2.dom, marche: true });
      legs.push({ kind: 'reg', team: g.exterieur, game_id: g.game_id, label: `${g.exterieur} gagne en 60 min`, match: m, prob: g.p_reg_ext, cote: g.cote1x2.ext, marche: true });
      legs.push({ kind: 'reg', team: 'nul', game_id: g.game_id, label: `Match nul après 60 min`, match: m, prob: g.p_nul_reg, cote: g.cote1x2.nul, marche: true });
    }
    if (g.ou) {
      legs.push({ kind: 'over', line: g.ou.line, game_id: g.game_id, label: `Plus de ${g.ou.line} buts`, match: m, prob: g.ou.p_over, cote: g.ou.cote_over, marche: true });
      legs.push({ kind: 'under', line: g.ou.line, game_id: g.game_id, label: `Moins de ${g.ou.line} buts`, match: m, prob: g.ou.p_under, cote: g.ou.cote_under, marche: true });
    }
  }
  for (const p of eligible) {
    const base = { player_id: p.id, game_id: p.game_id, match: p.match, marche: false };
    if (p.p_point >= 0.55) legs.push({ ...base, kind: 'point', label: `${p.nom} : au moins 1 point`, prob: p.p_point, cote: r3(1 / p.p_point, 2) });
    if (p.p_point2 >= 0.3) legs.push({ ...base, kind: '2pts', label: `${p.nom} : 2 points ou plus`, prob: p.p_point2, cote: r3(1 / p.p_point2, 2) });
    if (p.p_but >= 0.25) legs.push({ ...base, kind: 'but', label: `${p.nom} : marque un but`, prob: p.p_but, cote: r3(1 / p.p_but, 2) });
  }

  // ---- Meilleurs paris à cote 2 ou plus : seulement ceux où la cote réelle dépasse ce que vaut le pari selon moi
  const cote2 = legs.filter(l => l.marche && l.cote >= 2 && l.prob * l.cote - 1 >= 0.05)   // audit : à +3 % le bilan était négatif
    .map(l => ({ ...l, ev: r3(l.prob * l.cote - 1, 3), cote_juste: r3(1 / l.prob, 2) }))
    .sort((x, y) => y.ev - x.ev).slice(0, 5);
  // et les meilleures cotes justes ≥ 2 côté joueurs (à jouer seulement si Winamax paie au moins cette cote)
  const cote2j = legs.filter(l => !l.marche && l.cote >= 2).sort((x, y) => y.prob - x.prob).slice(0, 4);

  // ---- Pari fun : combinaison la plus probable qui atteint la cote visée, un pari par match (indépendance)
  const funSearch = (target: number, maxLegs: number) => {
    // Avec des cotes justes, toute combinaison à cote T a environ 1 chance sur T : ce qui fait la différence, c'est
    // la valeur des cotes du marché (espérance) et le nombre de paris (chaque jambe ajoute la marge du bookmaker).
    // Audit : 1 pari fun gagné sur 27 pour environ 4 attendus. Les jambes « joueur » (cote juste, sans marché) cumulaient
    // les erreurs du modèle : on les décote de 5 % et on préfère les jambes cotées par le marché.
    const pool = legs.filter(l => l.prob >= 0.25).map(l => l.marche ? l : { ...l, prob: l.prob * 0.95 })
      .sort((x, y) => (y.prob * y.cote) - (x.prob * x.cote) || y.prob - x.prob).slice(0, 30);
    let best: any = null;
    const score = (c: any) => c.prob * c.cote - 0.03 * c.legs.length;   // espérance, pénalité par jambe
    const rec = (start: number, chosen: any[], prob: number, cote: number) => {
      if (cote >= target && chosen.length >= 2) {
        if (cote <= target * 1.8) { const c = { legs: [...chosen], prob, cote }; if (!best || score(c) > score(best)) best = c; }
        return;
      }
      if (chosen.length === maxLegs) return;
      for (let i = start; i < pool.length; i++) {
        const l = pool[i];
        if (chosen.some(c => c.game_id === l.game_id)) continue;
        chosen.push(l); rec(i + 1, chosen, prob * l.prob, cote * l.cote); chosen.pop();
      }
    };
    rec(0, [], 1, 1);
    return best ? { cible: target, prob: r3(best.prob, 3), cote: r3(best.cote, 2), cote_juste: r3(1 / best.prob, 2),
      legs: best.legs.map((l: any) => ({ kind: l.kind, team: l.team, line: l.line, player_id: l.player_id, game_id: l.game_id, label: l.label, match: l.match, prob: l.prob, cote: l.cote, marche: l.marche })) } : null;
  };
  // Paris fun à thème (demandé après 1 gagnant sur 27) : au plus UN pari sur le total de buts,
  // un seul pari par match, jambes « joueur » décotées de 5 % (erreur du modèle), meilleure espérance pour la cote visée.
  const themed = (theme: string, target: number, quota: Record<string, [number, number]>, minLegs: number, maxLegs: number) => {
    const kinds = Object.keys(quota);
    const pool = legs.filter(l => kinds.includes(l.kind) && l.prob >= 0.2).map(l => l.marche ? l : { ...l, prob: l.prob * 0.95 })
      .sort((x, y) => (y.prob * y.cote) - (x.prob * x.cote) || y.prob - x.prob).slice(0, 40);
    let best: any = null;
    const count = (c: any[], k: string) => c.filter(x => x.kind === k).length;
    const ok = (c: any[]) => kinds.every(k => count(c, k) >= quota[k][0]) && count(c, 'over') + count(c, 'under') <= 1;
    const score = (c: any) => c.prob * c.cote - 0.03 * c.legs.length;
    const rec = (start: number, chosen: any[], prob: number, cote: number) => {
      if (chosen.length >= minLegs && cote >= target && ok(chosen)) {
        const c = { legs: [...chosen], prob, cote };
        if (cote <= target * 2.5 && (!best || score(c) > score(best))) best = c;
      }
      if (chosen.length === maxLegs) return;
      for (let i = start; i < pool.length; i++) {
        const l = pool[i];
        if (chosen.some(c => c.game_id === l.game_id)) continue;
        if (count(chosen, l.kind) >= quota[l.kind][1]) continue;
        if ((l.kind === 'over' || l.kind === 'under') && count(chosen, 'over') + count(chosen, 'under') >= 1) continue;
        chosen.push(l); rec(i + 1, chosen, prob * l.prob, cote * l.cote); chosen.pop();
      }
    };
    rec(0, [], 1, 1);
    return best ? { theme, cible: target, prob: r3(best.prob, 3), cote: r3(best.cote, 2), cote_juste: r3(1 / best.prob, 2),
      legs: best.legs.map((l: any) => ({ kind: l.kind, team: l.team, line: l.line, player_id: l.player_id, game_id: l.game_id, label: l.label, match: l.match, prob: l.prob, cote: l.cote, marche: l.marche })) } : null;
  };
  const fun = [
    themed('Buteurs', 5, { but: [2, 4] }, 2, 4),
    themed('Victoire + buteur', 5, { win: [1, 3], but: [1, 1] }, 2, 4),
    themed('Mélange', 6, { point: [1, 1], but: [1, 1], win: [1, 1], over: [0, 1], under: [0, 1] }, 3, 4),
  ].filter(Boolean) as any[];
  // ---- Pari safe du jour (modèle « ticket Winamax ») : victoires d'équipe + points de joueurs sûrs, cote 3 à 4,5.
  // Backtest moteur v2 : 5 tickets gagnés sur 12 (42 %) pour une cote moyenne de 3,3.
  const safe = (() => {
    const winL = liveG.flatMap(g => {
      const out: any[] = [];
      for (const [team, p, cote, mk] of [[g.domicile, g.p_dom, g.cote_dom, true], [g.exterieur, g.p_ext, g.cote_ext, true]] as const) {
        if (p < 0.55 || (g.confiance === 'Faible' && cote)) continue;   // le matin (sans cotes ni compositions) tout est « Faible » : ticket provisoire
        const c = cote || r3(1 / p, 2);
        const why = [...(g.pro?.notes || []).slice(0, 2), ...(g.logique || []).filter((t: string) => /Gardien|2e match|Absences|Forme/.test(t)).slice(0, 2)];
        out.push({ kind: 'win', team, game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, label: `${team} gagne (prolongation incluse)`, prob: p, cote: c, marche: !!cote, why });
      }
      return out;
    });
    const ptL = pts.filter((p: any) => p.niveau === 'Choix sûr' || p.prob >= 0.72).map((p: any) => ({
      kind: 'point', player_id: p.id, game_id: p.game_id, match: p.match, label: `${p.nom} : au moins 1 point`, prob: p.prob,
      cote: r3(Math.max(1.15, 0.93 / p.prob), 2), marche: false, why: (p.raisons || []).slice(0, 3) }));
    const pool = [...winL, ...ptL];
    let best: any = null;
    const rec = (start: number, chosen: any[], prob: number, cote: number) => {
      const nW = chosen.filter(c => c.kind === 'win').length, nP = chosen.length - nW;
      if (chosen.length >= 2 && nW >= 1 && nP >= 1 && cote >= 3 && cote <= 4.5) {
        const sc = prob * cote - 0.02 * chosen.length;
        if (!best || sc > best.sc) best = { legs: [...chosen], prob, cote, sc };
      }
      if (chosen.length === 4) return;
      for (let i = start; i < pool.length; i++) {
        const l = pool[i];
        if (chosen.some(c => c.game_id === l.game_id)) continue;
        chosen.push(l); rec(i + 1, chosen, prob * l.prob, cote * l.cote); chosen.pop();
      }
    };
    rec(0, [], 1, 1);
    if (!best) return null;
    return { prob: r3(best.prob, 3), cote: r3(best.cote, 2), cote_juste: r3(1 / best.prob, 2), ev: r3(best.prob * best.cote - 1, 3),
      provisoire: best.legs.some((l: any) => l.kind === 'win' && !l.marche),
      legs: best.legs.map((l: any) => ({ kind: l.kind, team: l.team, player_id: l.player_id, game_id: l.game_id, match: l.match, label: l.label, prob: r3(l.prob), cote: l.cote, marche: l.marche, why: l.why })) };
  })();

  // Méga combiné points : le joueur le plus sûr de chaque match, plus un 2e (de l'AUTRE équipe) s'il dépasse 72 %.
  // Deux joueurs d'une même équipe ratent souvent ensemble quand elle est muselée : on les évite.
  const megaLegs: any[] = [];
  for (const g of liveG) {
    const ps = eligible.filter((p: any) => p.game_id === g.game_id && p.p_point != null).sort((x: any, y: any) => y.p_point - x.p_point);
    if (!ps.length) continue;
    const first = ps[0];
    megaLegs.push(first);
    const second = ps.find((p: any) => p.equipe !== first.equipe && p.p_point >= 0.72);
    if (second) megaLegs.push(second);
  }
  if (megaLegs.length >= 3) {
    const prob = megaLegs.reduce((a: number, p: any) => a * p.p_point, 1);
    fun.push({ theme: 'Méga points', cible: megaLegs.length, prob: r3(prob, 4), cote: r3(1 / prob, 2), cote_juste: r3(1 / prob, 2),
      legs: megaLegs.map((p: any) => ({ kind: 'point', player_id: p.id, game_id: p.game_id, label: `${p.nom} : au moins 1 point`, match: p.match, prob: p.p_point, cote: r3(1 / p.p_point, 2), marche: false })) });
  }

  // ---- Accord avec les autres parieurs : mon favori + leaders Covers (+ marché), leur poids dépend de leur preuve
  const lead = signaux.find((x: any) => /Leaders Covers \(/.test(x.signal));
  const accord = liveG.filter(g => g.parieurs?.leaders_pick).map(g => {
    const fav = g.p_dom >= g.p_ext ? g.domicile : g.exterieur, p = Math.max(g.p_dom, g.p_ext);
    const agree = g.parieurs.leaders_pick === fav;
    const bonus = agree && lead?.prouve ? r3(Math.min(0.05, (lead.taux - 0.5) / 2), 3) : 0;
    return { game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, equipe: fav, accord: agree, prob: p, prob_mixte: r3(Math.min(0.95, p + bonus), 3),
      leaders: `${g.parieurs.leaders_ext}–${g.parieurs.leaders_dom}`, public: g.parieurs.public_dom != null ? `${g.parieurs.public_ext}–${g.parieurs.public_dom} %` : null,
      cote: fav === g.domicile ? g.cote_dom : g.cote_ext, poids: lead?.prouve ? 'prouvé' : `en observation (${lead?.n ?? 0}/30 matchs)` };
  }).sort((x, y) => (y.accord ? 1 : 0) - (x.accord ? 1 : 0) || y.prob_mixte - x.prob_mixte);

  return { safe, cote2, cote2j, fun, accord, points: pts, buts: pickTop('p_but'), equipes, pieges, relance, tirs, combines: pairs.slice(0, 2), deux_points: ambitieux('p_point2', 5, '2 points ou plus'), deux_buts: ambitieux('p_but2', 3, '2 buts ou plus') };
}

function fmtSec(s: any) { if (!s) return null; s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

async function enrichLogs(ctx: Ctx, pr: any, opp: string) {
  const cur = (await safe(`${W}/player/${pr.id}/game-log/${ctx.cur}/2`, {} as any)).gameLog || [];
  const prv = cur.length >= 10 ? [] : ((await safe(`${W}/player/${pr.id}/game-log/${ctx.prev}/2`, {} as any)).gameLog || []);
  const logs = [...cur, ...prv].filter((x: any) => x.gameDate < ctx.today).sort((a: any, b: any) => b.gameDate.localeCompare(a.gameDate));
  const l10 = logs.slice(0, 10), n = l10.length;
  const lf = logs.slice(0, 30);
  if (lf.length >= 10) { pr.freq_n = lf.length; pr.freq_pts = lf.filter((x: any) => x.points > 0).length / lf.length; pr.regularite = `Point dans ${lf.filter((x: any) => x.points > 0).length} de ses ${lf.length} derniers matchs`; }
  pr.l10_mj = n;
  pr.l10_buts_match = n ? r3(l10.reduce((s: number, x: any) => s + x.goals, 0) / n, 2) : null;
  pr.l10_pts_match = n ? r3(l10.reduce((s: number, x: any) => s + x.points, 0) / n, 2) : null;
  const run = (f: (x: any) => boolean) => { let k = 0; for (const x of logs) { if (f(x)) k++; else break; } return k; };
  const sp = run(x => x.points > 0), sg = run(x => x.goals > 0), dry = run(x => x.points === 0);
  const seq: string[] = [];
  if (sp >= 2) seq.push(`Points dans ${sp} matchs consécutifs`);
  if (sg >= 2) seq.push(`Buts dans ${sg} matchs consécutifs`);
  if (!seq.length && dry >= 3) seq.push(`Aucun point depuis ${dry} matchs`);
  pr.sequence = seq.join(' ; ') || '-';
  const sh10 = l10.reduce((s: number, x: any) => s + (x.shots || 0), 0), g10 = l10.reduce((s: number, x: any) => s + x.goals, 0);
  if (n >= 5 && pr.s_rate != null) {
    const recentShots = sh10 / n;
    const newS = 0.8 * pr.s_rate + 0.2 * recentShots;            // un changement de rôle se voit d'abord dans les tirs
    pr.g_rate = Math.max(0, pr.g_rate + 0.75 * (newS - pr.s_rate) * pr.sh_true);
    pr.p_rate = pr.g_rate + pr.a_rate;
    pr.s_rate = newS;
    const xg10 = sh10 * pr.sh_true;
    pr.l10_tirs_match = r3(recentShots, 2);
    pr.chance = r3(g10 - xg10, 2);                                 // buts réels - buts attendus sur 10 matchs
    if (g10 - xg10 >= 1.8 && sh10 > 0) pr.lecture = `Série flatteuse : ${g10} buts sur ${sh10} tirs en ${n} matchs (${Math.round(100 * g10 / sh10)} % de réussite, habituellement ${(pr.sh_true * 100).toFixed(0)} %). Cette réussite ne dure pas : le modèle ne la prolonge pas.`;
    else if (xg10 - g10 >= 1.5 && recentShots >= 2.5) pr.lecture = `Malchanceux : ${sh10} tirs en ${n} matchs pour ${g10} but(s), alors que sa réussite habituelle (${(pr.sh_true * 100).toFixed(0)} %) en donnerait environ ${xg10.toFixed(1)}. Le volume de tirs est là : le modèle s'attend à un retour à la normale.`;
    else pr.lecture = `Production cohérente avec son volume de tirs (${g10} buts pour ${xg10.toFixed(1)} attendus sur ${n} matchs).`;
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
  }
  const vs = logs.filter((x: any) => x.opponentAbbrev === opp);
  pr.vs_adv = vs.length ? `${vs.length} MJ, ${vs.reduce((s: number, x: any) => s + x.goals, 0)} B, ${vs.reduce((s: number, x: any) => s + x.points, 0)} PTS` : 'aucun match récent';
}

// ------------------------------------------------------------------ fiabilité & entretien
export function reliability(db: any) {
  return ['Vainqueur', 'But joueur', 'Passe joueur', 'Point joueur', 'Sélection équipe', 'Sélection but', 'Sélection point', 'Sélection tirs 2+', 'Sélection tirs 3+', 'Combiné point', 'Sélection 2+ points', 'Sélection 2+ buts', 'Lecture pro', 'Cote 2+', 'Pari fun 5+', 'Pari fun 10+', 'Pari fun Buteurs', 'Pari fun Victoire + buteur', 'Pari fun Mélange', 'Pari fun Méga points', 'Pari safe du jour', 'Pari parieur Covers', 'Buteur du soir'].map(typ => {
    const rows = db.predictions.filter((p: any) => p.type === typ && (p.resultat === 0 || p.resultat === 1));
    if (!rows.length) return { type: typ, n: 0 };
    const fav = rows.filter((p: any) => p.prob >= 0.5), val = rows.filter((p: any) => p.valeur === 'Valeur potentielle');
    const buckets = [[0, .2], [.2, .35], [.35, .5], [.5, .65], [.65, 1.01]].map(([lo, hi]) => {
      const b = rows.filter((p: any) => p.prob >= lo && p.prob < hi);
      return b.length ? { tranche: `${Math.round(lo * 100)}-${Math.min(100, Math.round(hi * 100))} %`, n: b.length, prevu: r3(b.reduce((s: number, p: any) => s + p.prob, 0) / b.length), reel: r3(b.reduce((s: number, p: any) => s + p.resultat, 0) / b.length) } : null;
    }).filter(Boolean);
    const valWithOdds = val.filter((p: any) => p.cote);
    return {
      type: typ, n: rows.length, n_fav: fav.length, reussite_fav: fav.length ? r3(fav.reduce((s: number, p: any) => s + p.resultat, 0) / fav.length) : null,
      n_valeur: val.length, reussite_valeur: val.length ? r3(val.reduce((s: number, p: any) => s + p.resultat, 0) / val.length) : null,
      roi_valeur: valWithOdds.length ? r3(valWithOdds.reduce((s: number, p: any) => s + (p.resultat ? p.cote - 1 : -1), 0) / valWithOdds.length) : null,
      brier: r3(rows.reduce((s: number, p: any) => s + (p.prob - p.resultat) ** 2, 0) / rows.length), prevu_moy: r3(rows.reduce((s: number, p: any) => s + p.prob, 0) / rows.length),
      reel_moy: r3(rows.reduce((s: number, p: any) => s + p.resultat, 0) / rows.length), tranches: buckets,
      premiere_date: rows.reduce((m: string, p: any) => p.date < m ? p.date : m, '9999'), derniere_date: rows.reduce((m: string, p: any) => p.date > m ? p.date : m, ''),
    };
  });
}

// ------------------------------------------------------------------ après-match : pourquoi ça a marché ou raté
/** Une jambe de pari : 1 gagnée, 0 perdue, null si le joueur n'a pas joué. */
function gradeLeg(l: any, box: any) {
  const a = box.awayTeam, h = box.homeTeam, tot = a.score + h.score;
  const lp = box.gameOutcome?.lastPeriodType || box.periodDescriptor?.periodType || 'REG';
  const kind = l.kind || 'point';
  if (kind === 'win') return +((a.score > h.score ? a.abbrev : h.abbrev) === l.team);
  if (kind === 'reg') { if (lp !== 'REG') return +(l.team === 'nul'); return +(l.team !== 'nul' && (a.score > h.score ? a.abbrev : h.abbrev) === l.team); }
  if (kind === 'spread') { const m = (l.team === h.abbrev ? h.score - a.score : a.score - h.score) + l.line; return m === 0 ? null : +(m > 0); }
  if (kind === 'over') return tot === l.line ? null : +(tot > l.line);
  if (kind === 'under') return tot === l.line ? null : +(tot < l.line);
  const st = boxPlayers(box).get(l.player_id);
  if (!st) return null;
  if (kind === 'point') return +(st.points > 0);
  if (kind === '2pts') return +(st.points >= 2);
  if (kind === 'but') return +(st.goals > 0);
  if (kind === '2buts') return +(st.goals >= 2);
  if (kind === 'tirs2') return +((st.sog || 0) >= 2);
  return null;
}

/** Tous les paris à cote 2+, combinés, paris fun et paris d'autres parieurs depuis le début, avec gain à mise fixe (1 unité). */
function parisSuivis(db: any) {
  const T = ['Pari safe du jour', 'Cote 2+', 'Combiné point', 'Pari fun 5+', 'Pari fun 10+', 'Pari fun Buteurs', 'Pari fun Victoire + buteur', 'Pari fun Mélange', 'Pari fun Méga points', 'Pari parieur Covers', 'Pari top Covers', 'Consensus OLBG', 'Pari tipster OLBG'];
  const matchOf = new Map<number, string>();
  for (const r of db.results) matchOf.set(r.game_id, `${r.exterieur} @ ${r.domicile}`);
  for (const p of db.predictions) if (p.match && !matchOf.has(p.game_id)) matchOf.set(p.game_id, p.match);
  const scoreOf = new Map<number, string>(db.results.map((r: any) => [r.game_id, `${r.exterieur} ${r.score_ext}–${r.score_dom} ${r.domicile}`]));
  const rows = db.predictions.filter((p: any) => T.includes(p.type)).map((p: any) => {
    const labels = String(p.selection || '').split(' + ');
    const cote = p.cote ?? (p.type === 'Combiné point' && p.prob ? r3(1 / p.prob, 2) : null);
    const gain = p.resultat === 1 && cote ? r3(cote - 1, 2) : p.resultat === 0 ? -1 : null;
    return {
      date: p.date, type: p.type, selection: p.selection, cote, cote_juste: p.type === 'Combiné point', prob: p.prob, resultat: p.resultat ?? null, gain,
      jambes: (p.legs || [{ game_id: p.game_id }]).map((l: any, i: number) => ({ label: l.label || (p.legs?.length > 1 ? labels[i] : p.selection), match: l.match || matchOf.get(l.game_id) || '', score: scoreOf.get(l.game_id) || null, res: p.legs_res ? p.legs_res[i] : (p.legs ? null : p.resultat) })),
    };
  }).sort((a: any, b: any) => b.date.localeCompare(a.date));
  const bilan = ['Tous', ...T].map(t => {
    const g = rows.filter((r: any) => (t === 'Tous' || r.type === t) && (r.resultat === 0 || r.resultat === 1));
    const withOdds = g.filter((r: any) => r.gain != null);
    const profit = withOdds.reduce((s: number, r: any) => s + r.gain, 0);
    return { type: t, n: g.length, gagnes: g.filter((r: any) => r.resultat === 1).length, en_attente: rows.filter((r: any) => (t === 'Tous' || r.type === t) && r.resultat == null).length, profit: r3(profit, 2), roi: withOdds.length ? r3(profit / withOdds.length, 3) : null };
  });
  return { bilan, paris: rows.slice(0, 300) };
}

/** Bilan des signaux : chaque source doit prouver qu'elle gagne plus d'une fois sur deux (test à 5 %). */
function signalBilan(db: any) {
  const S = (db.signals || []).filter((x: any) => x.res);
  const lab: Record<string, string> = { modele: 'Mon modèle (favori)', public: 'Le public (camp majoritaire)', leaders: 'Leaders Covers (vérifiés par la plateforme)', mouvement_inverse: 'Mouvement inverse de la cote', pro: 'Ma lecture pro « Jouable »' };
  const row = (name: string, arr: number[]) => {
    const n = arr.length, w = arr.reduce((s, x) => s + x, 0);
    const z = n ? (w / n - 0.5) / Math.sqrt(0.25 / n) : 0;
    return { signal: name, n, gagnes: w, taux: n ? r3(w / n) : null, prouve: n >= 30 && z >= 1.96, z: r3(z, 2) };
  };
  const out = Object.keys(lab).map(k => row(lab[k], S.map((x: any) => x.res?.[k]).filter((v: any) => v === 0 || v === 1)));
  const ou = (db.signals || []).filter((x: any) => x.ou_res);
  out.push(row('Public sur le total (plus/moins)', ou.map((x: any) => x.ou_res.public).filter((v: any) => v === 0 || v === 1)));
  out.push(row('Leaders Covers sur le total', ou.map((x: any) => x.ou_res.leaders).filter((v: any) => v === 0 || v === 1)));
  return out;
}

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
      { date: p.date, game_id: p.game_id, equipe: h.abbrev, adversaire: a.abbrev, xg: xd, xg_scale: sc, xgm: p.xgm_dom ?? null, xgk: p.xgk_dom ?? null, v: p.v ?? 1, buts: h.score, tirs: h.sog, sv_adv: svOf('awayTeam') },
      { date: p.date, game_id: p.game_id, equipe: a.abbrev, adversaire: h.abbrev, xg: xe, xg_scale: sc, xgm: p.xgm_ext ?? null, xgk: p.xgk_ext ?? null, v: p.v ?? 1, buts: a.score, tirs: a.sog, sv_adv: svOf('homeTeam') },
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

async function backfillPostMatch(db: any, params: Params) {
  db.postmatch = { teams: [], players: [] };
  const done = db.predictions.filter((p: any) => p.resultat != null && p.game_id && ['Vainqueur', 'Point joueur', 'But joueur'].includes(p.type));
  const ids = [...new Set<number>(done.map((p: any) => p.game_id))];
  const boxes = new Map<number, any>((await pool(ids, 16, async id => [id, await safe(`${W}/gamecenter/${id}/boxscore`, null)] as const)).filter(([, b]) => b));
  for (const p of done) { const b = boxes.get(p.game_id); if (b) postMatch(db, p, b, params); }
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
  }
  db.players = db.players.filter((x: any) => daysBetween(x.date, today) <= 60);
  db.injuries = db.injuries.filter((x: any) => daysBetween(x.date, today) <= 60);
  // prédictions joueurs : on garde l'essentiel pour l'apprentissage au-delà de 60 jours
  for (const p of db.predictions) if (p.type !== 'Vainqueur' && daysBetween(p.date, today) > 60) { delete p.consulte; delete p.match; delete p.domicile; delete p.exterieur; }
}
