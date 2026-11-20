// Lecture des données NBA publiques d'ESPN (diffuseur officiel de la NBA) — nba.com refuse les programmes automatiques
// (« Access Denied ») sauf le fichier des cinq majeurs, lu à part. Choix validé le 09/11/2026.
import { safe, nameMatch, norm } from '../util.mts';

export const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
export const ESPN_STATS = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete';

/** ESPN abrège parfois autrement que nba.com : on ramène tout aux abréviations nba.com. */
const FIX: Record<string, string> = { GS: 'GSW', NY: 'NYK', NO: 'NOP', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS', UTH: 'UTA', PHO: 'PHX', BRK: 'BKN', CHO: 'CHA' };
export const ab = (x: string) => FIX[x] || x;

export const TEAM_NAMES: Record<string, string> = {
  ATL: 'Atlanta Hawks', BOS: 'Boston Celtics', BKN: 'Brooklyn Nets', CHA: 'Charlotte Hornets', CHI: 'Chicago Bulls', CLE: 'Cleveland Cavaliers',
  DAL: 'Dallas Mavericks', DEN: 'Denver Nuggets', DET: 'Detroit Pistons', GSW: 'Golden State Warriors', HOU: 'Houston Rockets', IND: 'Indiana Pacers',
  LAC: 'LA Clippers', LAL: 'Los Angeles Lakers', MEM: 'Memphis Grizzlies', MIA: 'Miami Heat', MIL: 'Milwaukee Bucks', MIN: 'Minnesota Timberwolves',
  NOP: 'New Orleans Pelicans', NYK: 'New York Knicks', OKC: 'Oklahoma City Thunder', ORL: 'Orlando Magic', PHI: 'Philadelphia 76ers', PHX: 'Phoenix Suns',
  POR: 'Portland Trail Blazers', SAC: 'Sacramento Kings', SAS: 'San Antonio Spurs', TOR: 'Toronto Raptors', UTA: 'Utah Jazz', WAS: 'Washington Wizards',
};
export const CONF: Record<string, [string, string]> = {
  ATL: ['Est', 'Sud-Est'], BOS: ['Est', 'Atlantique'], BKN: ['Est', 'Atlantique'], CHA: ['Est', 'Sud-Est'], CHI: ['Est', 'Centrale'], CLE: ['Est', 'Centrale'],
  DAL: ['Ouest', 'Sud-Ouest'], DEN: ['Ouest', 'Nord-Ouest'], DET: ['Est', 'Centrale'], GSW: ['Ouest', 'Pacifique'], HOU: ['Ouest', 'Sud-Ouest'], IND: ['Est', 'Centrale'],
  LAC: ['Ouest', 'Pacifique'], LAL: ['Ouest', 'Pacifique'], MEM: ['Ouest', 'Sud-Ouest'], MIA: ['Est', 'Sud-Est'], MIL: ['Est', 'Centrale'], MIN: ['Ouest', 'Nord-Ouest'],
  NOP: ['Ouest', 'Sud-Ouest'], NYK: ['Est', 'Atlantique'], OKC: ['Ouest', 'Nord-Ouest'], ORL: ['Est', 'Sud-Est'], PHI: ['Est', 'Atlantique'], PHX: ['Ouest', 'Pacifique'],
  POR: ['Ouest', 'Nord-Ouest'], SAC: ['Ouest', 'Pacifique'], SAS: ['Ouest', 'Sud-Ouest'], TOR: ['Est', 'Atlantique'], UTA: ['Ouest', 'Nord-Ouest'], WAS: ['Est', 'Sud-Est'],
};
/** Pour lire les noms d'équipes de covers.com (« LA Lakers », « Golden State »…). */
export const PLACE: Record<string, string> = Object.fromEntries(Object.entries(TEAM_NAMES).flatMap(([k, v]) => {
  const n = norm(v), parts = n.split(' '), nick = parts[parts.length - 1];
  return [[n, k], [parts.slice(0, -1).join(' '), k], [nick, k]];
}).concat([['la lakers', 'LAL'], ['la clippers', 'LAC'], ['los angeles clippers', 'LAC'], ['trail blazers', 'POR'], ['blazers', 'POR'], ['76ers', 'PHI'], ['sixers', 'PHI'], ['golden st', 'GSW'], ['okla city', 'OKC'], ['oklahoma city', 'OKC'], ['new york', 'NYK'], ['brooklyn', 'BKN'], ['portland', 'POR']]));

const ymd = (iso: string) => iso.replace(/-/g, '');
const amToDec = (v: any) => { const x = parseFloat(String(v ?? '').replace('EVEN', '+100')); return !isFinite(x) || x === 0 ? null : x > 0 ? 1 + x / 100 : 1 + 100 / -x; };

export interface Odds { fournisseur: string; spread_dom: number | null; total: number | null; ml_dom: number | null; ml_ext: number | null; ml_dom_open: number | null; ml_ext_open: number | null;
  sp_cote_dom: number | null; sp_cote_ext: number | null; over_cote: number | null; under_cote: number | null; spread_open: number | null; total_open: number | null }
export interface SbGame { id: string; date: string; utc: string; etat: 'pre' | 'in' | 'post'; termine: boolean; statut: string; ext: string; dom: string; score_ext: number | null; score_dom: number | null;
  qt_ext: number[]; qt_dom: number[]; salle: string; ville: string; note: string | null; odds: Odds | null; neutre: boolean }

function parseOdds(o: any): Odds | null {
  if (!o) return null;
  const ln = (x: any) => { const v = parseFloat(String(x ?? '').replace(/^[ou]/i, '')); return isFinite(v) ? v : null; };
  return {
    fournisseur: o.provider?.displayName || o.provider?.name || 'non précisé',
    spread_dom: ln(o.pointSpread?.home?.close?.line) ?? (o.spread != null ? +o.spread : null),
    total: ln(o.total?.over?.close?.line) ?? (o.overUnder != null ? +o.overUnder : null),
    ml_dom: amToDec(o.moneyline?.home?.close?.odds), ml_ext: amToDec(o.moneyline?.away?.close?.odds),
    ml_dom_open: amToDec(o.moneyline?.home?.open?.odds), ml_ext_open: amToDec(o.moneyline?.away?.open?.odds),
    sp_cote_dom: amToDec(o.pointSpread?.home?.close?.odds), sp_cote_ext: amToDec(o.pointSpread?.away?.close?.odds),
    over_cote: amToDec(o.total?.over?.close?.odds), under_cote: amToDec(o.total?.under?.close?.odds),
    spread_open: ln(o.pointSpread?.home?.open?.line), total_open: ln(o.total?.over?.open?.line),
  };
}

export async function scoreboard(dateIso: string): Promise<SbGame[]> {
  const d = await safe<any>(`${ESPN}/scoreboard?dates=${ymd(dateIso)}`, { events: [] });
  return (d.events || []).filter((e: any) => [2, 3, 5].includes(e.season?.type) || e.season?.type == null).map((e: any) => {
    const c = e.competitions?.[0] || {};
    const H = c.competitors?.find((x: any) => x.homeAway === 'home'), A = c.competitors?.find((x: any) => x.homeAway === 'away');
    const st = c.status?.type || e.status?.type || {};
    const done = !!st.completed;
    return {
      id: String(e.id), date: dateIso, utc: e.date, etat: st.state || 'pre', termine: done, statut: st.shortDetail || st.description || '',
      ext: ab(A?.team?.abbreviation), dom: ab(H?.team?.abbreviation),
      score_ext: st.state !== 'pre' && A?.score != null ? +A.score : null, score_dom: st.state !== 'pre' && H?.score != null ? +H.score : null,
      qt_ext: (A?.linescores || []).map((l: any) => +l.value), qt_dom: (H?.linescores || []).map((l: any) => +l.value),
      salle: c.venue?.fullName || 'non disponible', ville: c.venue?.address?.city || '', note: (c.notes || []).map((n: any) => n.headline).filter(Boolean).join(' · ') || null,
      odds: parseOdds(c.odds?.[0]), neutre: !!c.neutralSite,
    } as SbGame;
  }).filter((g: SbGame) => g.ext && g.dom);
}

/** Ligne joueur compacte : [joueur, équipe, min, pts, fgm, fga, 3pm, 3pa, ftm, fta, reb, oreb, ast, stl, blk, tov, titulaire] */
export type PRow = [string, string, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
export interface Box { id: string; date: string; ext: string; dom: string; score_ext: number; score_dom: number; qt_ext: number[]; qt_dom: number[]; prol: number; salle: string;
  equipes: Record<string, { fga: number; fgm: number; p3a: number; p3m: number; fta: number; ftm: number; oreb: number; reb: number; ast: number; stl: number; blk: number; tov: number }>;
  joueurs: PRow[]; absents: { id: string; team: string; nom: string; raison: string }[]; noms: Record<string, [string, string]> }

const split = (s: string) => { const [a, b] = String(s || '0-0').split('-').map(Number); return [a || 0, b || 0]; };
export async function boxscore(id: string, dateIso: string): Promise<Box | null> {
  const s = await safe<any>(`${ESPN}/summary?event=${id}`, null);
  if (!s?.boxscore?.players?.length) return null;
  const comp = s.header?.competitions?.[0] || {};
  if (!comp.status?.type?.completed) return null;
  const H = comp.competitors?.find((x: any) => x.homeAway === 'home'), A = comp.competitors?.find((x: any) => x.homeAway === 'away');
  const qt = (t: any) => (t?.linescores || []).map((l: any) => +(l.displayValue ?? l.value ?? 0));
  const out: Box = { id, date: dateIso, ext: ab(A.team.abbreviation), dom: ab(H.team.abbreviation), score_ext: +A.score, score_dom: +H.score, qt_ext: qt(A), qt_dom: qt(H), prol: Math.max(0, qt(H).length - 4),
    salle: s.gameInfo?.venue?.fullName || 'non disponible', equipes: {}, joueurs: [], absents: [], noms: {} };
  for (const t of s.boxscore.teams || []) {
    const m: Record<string, string> = Object.fromEntries((t.statistics || []).map((x: any) => [x.name, x.displayValue]));
    const [fgm, fga] = split(m['fieldGoalsMade-fieldGoalsAttempted']), [p3m, p3a] = split(m['threePointFieldGoalsMade-threePointFieldGoalsAttempted']), [ftm, fta] = split(m['freeThrowsMade-freeThrowsAttempted']);
    out.equipes[ab(t.team.abbreviation)] = { fga, fgm, p3a, p3m, fta, ftm, oreb: +m.offensiveRebounds || 0, reb: +m.totalRebounds || 0, ast: +m.assists || 0, stl: +m.steals || 0, blk: +m.blocks || 0, tov: +(m.totalTurnovers ?? m.turnovers) || 0 };
  }
  for (const T of s.boxscore.players) {
    const team = ab(T.team.abbreviation), st = T.statistics?.[0];
    if (!st) continue;
    const K: string[] = st.keys || [];
    const idx = (k: string) => K.indexOf(k);
    for (const a of st.athletes || []) {
      const pid = String(a.athlete?.id);
      out.noms[pid] = [a.athlete?.displayName || '', a.athlete?.position?.abbreviation || ''];
      if (a.didNotPlay || !a.stats?.length) { out.absents.push({ id: pid, team, nom: a.athlete?.displayName, raison: a.reason || 'Ne joue pas' }); continue; }
      const g = (k: string) => a.stats[idx(k)];
      const [fgm, fga] = split(g('fieldGoalsMade-fieldGoalsAttempted')), [p3m, p3a] = split(g('threePointFieldGoalsMade-threePointFieldGoalsAttempted')), [ftm, fta] = split(g('freeThrowsMade-freeThrowsAttempted'));
      const min = parseFloat(String(g('minutes') ?? '0').split(':')[0]) || 0;
      out.joueurs.push([pid, team, min, +g('points') || 0, fgm, fga, p3m, p3a, ftm, fta, +g('rebounds') || 0, +g('offensiveRebounds') || 0, +g('assists') || 0, +g('steals') || 0, +g('blocks') || 0, +g('turnovers') || 0, a.starter ? 1 : 0]);
    }
  }
  return out;
}

export interface Inj { team: string; nom: string; id: string | null; statut: string; blessure: string; date: string; retour: string | null; commentaire: string }
export async function injuries(): Promise<{ ok: boolean; list: Inj[] }> {
  const d = await safe<any>(`${ESPN}/injuries`, null);
  if (!d?.injuries) return { ok: false, list: [] };
  const byName: Record<string, string> = Object.fromEntries(Object.entries(TEAM_NAMES).map(([k, v]) => [norm(v), k]));
  const list: Inj[] = [];
  for (const t of d.injuries) {
    const team = byName[norm(t.displayName)] || PLACE[norm(t.displayName)] || null;
    for (const i of t.injuries || []) {
      const a = i.athlete || {};
      const id = (JSON.stringify(a.links || []).match(/\/id\/(\d+)/) || [])[1] || null;
      list.push({ team: team || ab(a.team?.abbreviation || ''), nom: a.displayName || '', id, statut: i.status || i.type?.description || 'non précisé',
        blessure: [i.details?.type, i.details?.side && i.details.side !== 'Not Specified' ? i.details.side : null].filter(Boolean).join(' ') || 'non précisée',
        date: i.date || '', retour: i.details?.returnDate || null, commentaire: i.shortComment || '' });
    }
  }
  return { ok: true, list };
}

/** Moyennes d'une saison complète (priors de régression). season = année de fin (2026 pour 2025-26). */
export async function seasonAverages(season: number) {
  const d = await safe<any>(`${ESPN_STATS}?region=us&lang=en&contentorigin=espn&isqualified=false&page=1&limit=1000&sort=offensive.avgPoints%3Adesc&season=${season}&seasontype=2`, null);
  if (!d?.athletes) return {};
  const names: Record<string, string[]> = Object.fromEntries((d.categories || []).map((c: any) => [c.name, c.names]));
  const out: Record<string, any> = {};
  for (const a of d.athletes) {
    const v: Record<string, number> = {};
    for (const c of a.categories || []) (names[c.name] || []).forEach((n, i) => { v[n] = parseFloat(c.totals?.[i] ?? c.values?.[i]); });
    const gp = v.gamesPlayed || 0;
    if (!gp) continue;
    out[String(a.athlete.id)] = { nom: a.athlete.displayName, gp, min: v.minutes || v.avgMinutes * gp, pts: v.points, fga: v.fieldGoalsAttempted, fgm: v.fieldGoalsMade, p3a: v.threePointFieldGoalsAttempted, p3m: v.threePointFieldGoalsMade,
      fta: v.freeThrowsAttempted, ftm: v.freeThrowsMade, reb: v.rebounds, ast: v.assists, stl: v.steals, blk: v.blocks, tov: v.turnovers, dd: v.doubleDouble || 0 };
  }
  return out;
}

/** Cinq majeurs nba.com (seul fichier nba.com accessible) : « Expected » (attendus) ou « Confirmed ». */
export async function nbaLineups(dateIso: string) {
  const d = await safe<any>(`https://stats.nba.com/js/data/leaders/00_daily_lineups_${ymd(dateIso)}.json`, null);
  if (!d?.games) return { ok: false, games: [] as any[] };
  return { ok: true, games: d.games.map((g: any) => ({ dom: g.homeTeam?.teamAbbreviation, ext: g.awayTeam?.teamAbbreviation,
    joueurs: [...(g.homeTeam?.players || []).map((p: any) => ({ ...p, team: g.homeTeam.teamAbbreviation })), ...(g.awayTeam?.players || []).map((p: any) => ({ ...p, team: g.awayTeam.teamAbbreviation }))]
      .map((p: any) => ({ team: p.team, nom: p.playerName || `${p.firstName} ${p.lastName}`, pos: p.position || '', statut: p.lineupStatus || '', roster: p.rosterStatus || '', maj: p.timestamp || '' })) })) };
}
export const sameName = nameMatch;
