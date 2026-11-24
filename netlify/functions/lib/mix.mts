// Combinés « mélange » NHL + NBA + KHL/Europe : uniquement des sélections que les AUTRES parieurs jouent
// (public et meilleurs parieurs Covers pour la NHL et la NBA, vote des internautes sports.ru pour la KHL),
// vérifiées par mes chiffres (au moins 58 % de chances), assemblées pour viser une cote d'environ 2.
import { safe, r3 } from './util.mts';
import { scoreboard } from './nba/espn.mts';

export interface Leg { id: string; sport: string; game_id: string; date: string; utc: string | null; match: string; heure: string;
  kind: 'win' | 'over' | 'under' | 'eur'; team?: string; code?: string; line?: number; label: string; p: number; cote: number; foule: string; force: number }

const P_MIN = 0.58, COTE_MIN = 1.12;
const okLeg = (l: Partial<Leg>) => l.p != null && l.cote != null && l.p >= P_MIN && l.cote >= COTE_MIN && l.p * l.cote >= 0.90;  // pas de cote nettement trop basse (gros favoris du public tolérés)

/** Sélections jouées par les autres parieurs, encore à venir, avec cote et probabilité. */
export function crowdLegs(nhl: any, nba: any, eur: any, now = Date.now()): Leg[] {
  const out: Leg[] = [];
  const push = (l: Leg) => { if (okLeg(l)) out.push(l); };
  // NHL : public Covers (≥ 60 %) ou meilleurs parieurs (majorité nette)
  for (const g of nhl?.games || []) {
    if (!['FUT', 'PRE'].includes(g.etat)) continue;
    const pr = g.parieurs || {}, dom = g.domicile, ext = g.exterieur, m = `${ext} @ ${dom}`;
    for (const side of ['dom', 'ext'] as const) {
      const pub = pr[`public_${side}`], led = pr[`leaders_${side}`] || 0, oth = pr[`leaders_${side === 'dom' ? 'ext' : 'dom'}`] || 0;
      if (!((pub ?? 0) >= 60 || (led >= 5 && led >= 2 * oth))) continue;
      const team = side === 'dom' ? dom : ext;
      push({ id: `nhl:${g.game_id}:win:${team}`, sport: 'NHL', game_id: String(g.game_id), date: g.date, utc: null, match: m, heure: g.debut_paris, kind: 'win', team,
        label: `${team} gagne (prolongation incluse)`, p: g[`p_${side}`], cote: g[`cote_${side}`], force: Math.max(pub ?? 0, led + oth ? 100 * led / (led + oth) : 0),
        foule: [pub != null ? `${pub} % du public` : '', led ? `${led} meilleurs parieurs contre ${oth}` : ''].filter(Boolean).join(', ') });
    }
    const ou = g.ou;
    if (ou?.line != null) for (const s of ['over', 'under'] as const) {
      const pub = s === 'over' ? pr.over_pct : pr.over_pct != null ? 100 - pr.over_pct : null;
      const led = pr[`leaders_${s}`] || 0, oth = pr[`leaders_${s === 'over' ? 'under' : 'over'}`] || 0;
      if (!((pub ?? 0) >= 60 || (led >= 5 && led >= 2 * oth))) continue;
      push({ id: `nhl:${g.game_id}:${s}:${ou.line}`, sport: 'NHL', game_id: String(g.game_id), date: g.date, utc: null, match: m, heure: g.debut_paris, kind: s, line: ou.line,
        label: `${s === 'over' ? 'Plus' : 'Moins'} de ${ou.line} buts`, p: ou[`p_${s}`], cote: ou[`cote_${s}`], force: Math.max(pub ?? 0, led + oth ? 100 * led / (led + oth) : 0),
        foule: [pub != null ? `${pub} % du public` : '', led ? `${led} meilleurs parieurs contre ${oth}` : ''].filter(Boolean).join(', ') });
    }
  }
  // NBA : même logique (Covers)
  for (const g of nba?.games || []) {
    if (g.etat !== 'pre') continue;
    const pr = g.parieurs || {}, dom = g.domicile, ext = g.exterieur, m = `${ext} @ ${dom}`;
    for (const side of ['dom', 'ext'] as const) {
      const pub = pr[`public_${side}`], led = pr[`leaders_${side}`] || 0, oth = pr[`leaders_${side === 'dom' ? 'ext' : 'dom'}`] || 0;
      if (!((pub ?? 0) >= 60 || (led >= 5 && led >= 2 * oth))) continue;
      const team = side === 'dom' ? dom : ext;
      push({ id: `nba:${g.game_id}:win:${team}`, sport: 'NBA', game_id: String(g.game_id), date: g.date, utc: null, match: m, heure: g.debut_paris, kind: 'win', team,
        label: `${team} gagne`, p: g[`p_${side}`], cote: g[`cote_${side}`], force: Math.max(pub ?? 0, led + oth ? 100 * led / (led + oth) : 0),
        foule: [pub != null ? `${pub} % du public` : '', led ? `${led} meilleurs parieurs contre ${oth}` : ''].filter(Boolean).join(', ') });
    }
    const t = g.marches?.total;
    if (t?.line != null) for (const s of ['over', 'under'] as const) {
      const pub = s === 'over' ? pr.over_pct : pr.over_pct != null ? 100 - pr.over_pct : null;
      const led = pr[`leaders_${s}`] || 0, oth = pr[`leaders_${s === 'over' ? 'under' : 'over'}`] || 0;
      if (!((pub ?? 0) >= 60 || (led >= 5 && led >= 2 * oth))) continue;
      push({ id: `nba:${g.game_id}:${s}:${t.line}`, sport: 'NBA', game_id: String(g.game_id), date: g.date, utc: null, match: m, heure: g.debut_paris, kind: s, line: t.line,
        label: `${s === 'over' ? 'Plus' : 'Moins'} de ${t.line} points`, p: t[`p_${s}`], cote: t[`cote_${s}`], force: Math.max(pub ?? 0, led + oth ? 100 * led / (led + oth) : 0),
        foule: [pub != null ? `${pub} % du public` : '', led ? `${led} meilleurs parieurs contre ${oth}` : ''].filter(Boolean).join(', ') });
    }
  }
  // KHL : vote des internautes sports.ru (camp majoritaire, pari à plus de 50 % déjà choisi par le pipeline Europe)
  for (const x of eur?.public || []) {
    if (!x.utc || Date.parse(x.utc) < now) continue;
    push({ id: `eur:${x.game_id}:${x.code}`, sport: x.lg || 'KHL', game_id: String(x.game_id), date: String(x.utc).slice(0, 10), utc: x.utc, match: x.match, heure: x.heure, kind: 'eur', code: x.code,
      label: x.label, p: x.prob, cote: x.cote_book, force: Math.round(100 * x.part), foule: `${Math.round(100 * x.part)} % des ${x.votes} votants sports.ru` });
  }
  return out;
}

/** Combinés de 2 ou 3 sélections (matchs différents) dont la cote totale tourne autour de 2. */
export function bestCombos(legs: Leg[], n = 6) {
  const res: any[] = [];
  const L = [...legs].sort((a, b) => b.p - a.p).slice(0, 40);
  const add = (ls: Leg[]) => {
    if (new Set(ls.map(l => l.game_id)).size < ls.length) return;
    const cote = ls.reduce((t, l) => t * l.cote, 1), p = ls.reduce((t, l) => t * l.p, 1);
    if (cote < 1.8 || cote > 2.4) return;
    res.push({ legs: ls, cote: r3(cote, 2), prob: r3(p), ev: r3(p * cote - 1), sports: [...new Set(ls.map(l => l.sport))], foule: r3(ls.reduce((t, l) => t + l.force, 0) / ls.length, 0) });
  };
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
    add([L[i], L[j]]);
    for (let k = j + 1; k < L.length; k++) add([L[i], L[j], L[k]]);
  }
  // les plus sûrs d'abord ; on évite de répéter la même sélection dans plus de 2 combinés
  res.sort((a, b) => b.prob - a.prob || b.ev - a.ev);
  const used: Record<string, number> = {}, out: any[] = [];
  for (const c of res) {
    if (c.legs.some((l: Leg) => (used[l.id] || 0) >= 2)) continue;
    c.legs.forEach((l: Leg) => used[l.id] = (used[l.id] || 0) + 1);
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

// ---------------------------------------------------------------- résultats
async function nhlScores(date: string) {
  const d = await safe(`https://api-web.nhle.com/v1/score/${date}`, { games: [] as any[] });
  return new Map(d.games.filter((g: any) => ['OFF', 'FINAL'].includes(g.gameState)).map((g: any) => [String(g.id), { dom: g.homeTeam.abbrev, ext: g.awayTeam.abbrev, sd: g.homeTeam.score, se: g.awayTeam.score }]));
}
async function nbaScores(date: string) {
  const sb = await scoreboard(date);
  return new Map(sb.filter(g => g.termine).map(g => [String(g.id), { dom: g.dom, ext: g.ext, sd: g.score_dom!, se: g.score_ext! }]));
}
/** 1 gagné, 0 perdu, null pas encore connu. */
function legResult(l: Leg, sc: any, eurHist: any[]): number | null {
  if (l.kind === 'eur') {
    const h = eurHist.find(p => String(p.game_id) === l.game_id && p.code === l.code && (p.resultat === 0 || p.resultat === 1));
    return h ? h.resultat : null;
  }
  if (!sc) return null;
  const tot = sc.sd + sc.se;
  if (l.kind === 'win') return (l.team === sc.dom ? sc.sd > sc.se : sc.se > sc.sd) ? 1 : 0;
  if (l.kind === 'over') return tot > l.line! ? 1 : 0;
  if (l.kind === 'under') return tot < l.line! ? 1 : 0;
  return null;
}
export async function gradeMix(db: any, eur: any) {
  const pend = (db.combos || []).filter((c: any) => c.resultat == null);
  if (!pend.length) return 0;
  const cache: Record<string, Map<string, any>> = {};
  const scores = async (l: Leg) => {
    const k = `${l.sport}|${l.date}`;
    if (!cache[k]) cache[k] = l.sport === 'NHL' ? await nhlScores(l.date) : l.sport === 'NBA' ? await nbaScores(l.date) : new Map();
    return cache[k].get(l.game_id);
  };
  const eurHist = [...(eur?.historique || []), ...(eur?.historique_public || [])];
  let n = 0;
  for (const c of pend) {
    for (const l of c.legs) if (l.resultat == null) l.resultat = legResult(l, await scores(l), eurHist);
    const rs = c.legs.map((l: any) => l.resultat);
    if (rs.includes(0)) c.resultat = 0; else if (rs.every((r: any) => r === 1)) c.resultat = 1;
    else if (Date.now() - Date.parse(c.cree) > 4 * 86400000) c.resultat = -1;   // résultat introuvable après 4 jours : annulé
    if (c.resultat != null) n++;
  }
  return n;
}

/** Passage complet : note les anciens combinés, propose ceux du jour, garde le suivi. */
export async function runMix(db: any, nhl: any, nba: any, eur: any) {
  db.combos ||= [];
  const graded = await gradeMix(db, eur);
  const legs = crowdLegs(nhl, nba, eur);
  const combos = bestCombos(legs);
  const today = new Date().toISOString().slice(0, 10);
  // on suit le meilleur combiné de chaque passage (une fois par jour et par composition)
  for (const c of combos.slice(0, 3)) {
    const key = c.legs.map((l: Leg) => l.id).sort().join('|');
    if (!db.combos.some((x: any) => x.key === key)) db.combos.push({ key, cree: new Date().toISOString(), jour: today, cote: c.cote, prob: c.prob, legs: c.legs.map((l: Leg) => ({ ...l })), resultat: null });
  }
  db.combos = db.combos.slice(-300);
  const done = db.combos.filter((c: any) => c.resultat === 0 || c.resultat === 1);
  const bilan = done.length ? { n: done.length, gagnes: done.filter((c: any) => c.resultat === 1).length, unites: r3(done.reduce((t: number, c: any) => t + (c.resultat ? c.cote - 1 : -1), 0), 2) } : null;
  return { genere: new Date().toISOString(), legs: legs.sort((a, b) => b.p - a.p), combos, bilan, historique: db.combos.filter((c: any) => c.resultat != null).slice(-40).reverse(), graded };
}
