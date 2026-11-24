// Football : Ligue 1, Premier League, Liga, Serie A, Bundesliga, Saudi Pro League, Ligue des champions, Ligue Europa, Conférence.
// Forces des équipes tirées des classements ESPN (saison en cours mêlée à la précédente), buts attendus (loi de Poisson,
// léger surplus de nuls), mêlés aux cotes DraftKings quand elles existent. Seulement les paris à plus de 50 %, notés chaque jour.
import { kv } from '../store.mts';
import { parisStamp, r3, clamp, safe, pool } from '../util.mts';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer', ESPN2 = 'https://site.api.espn.com/apis/v2/sports/soccer';
export const LEAGUES = [
  { c: 'fra.1', n: 'Ligue 1', k: 0.90 }, { c: 'eng.1', n: 'Premier League', k: 1.0 }, { c: 'esp.1', n: 'Liga', k: 0.97 },
  { c: 'ita.1', n: 'Serie A', k: 0.95 }, { c: 'ger.1', n: 'Bundesliga', k: 0.94 }, { c: 'ksa.1', n: 'Saudi Pro League', k: 0.72 },
  { c: 'uefa.champions', n: 'Ligue des champions', k: 0, cup: true }, { c: 'uefa.europa', n: 'Ligue Europa', k: 0, cup: true }, { c: 'uefa.europa.conf', n: 'Conférence', k: 0, cup: true },
] as const;
const P = { K: 6, wPrior: 0.5, tau: 0.07, home: 1.12, away: 0.88, homeCup: 1.10, awayCup: 0.90, mCup: 1.40, wMkt: 0.65 };

const parisDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const parisHM = (iso: string) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)).replace(',', '');
const ymd = (d: string) => d.replace(/-/g, '');
const am2dec = (s: any) => { const v = parseFloat(String(s ?? '').replace('+', '')); if (!isFinite(v) || v === 0) return null; return r3(v > 0 ? 1 + v / 100 : 1 + 100 / -v, 2); };
const pois = (k: number, l: number) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return Math.exp(-l) * l ** k / f; };

interface Row { id: string; team: string; abbr: string; mj: number; v: number; n: number; d: number; bp: number; bc: number; pts: number }
async function standings(lg: string, season?: number): Promise<Row[]> {
  const d = await safe<any>(`${ESPN2}/${lg}/standings${season ? `?season=${season}` : ''}`, null);
  const out: Row[] = [];
  for (const ch of d?.children || (d?.standings ? [d] : [])) for (const e of ch.standings?.entries || []) {
    const s: Record<string, number> = Object.fromEntries((e.stats || []).map((x: any) => [x.name, x.value]));
    out.push({ id: String(e.team?.id), team: e.team?.shortDisplayName || e.team?.displayName, abbr: e.team?.abbreviation, mj: s.gamesPlayed || 0, v: s.wins || 0, n: s.ties || 0, d: s.losses || 0, bp: s.pointsFor || 0, bc: s.pointsAgainst || 0, pts: s.points || 0 });
  }
  return out;
}
interface Ev { id: string; lg: string; utc: string; dom: string; ext: string; domId: string; extId: string; etat: string; done: boolean; hs: number | null; as: number | null;
  odds: { c1: number | null; cX: number | null; c2: number | null; line: number | null; over: number | null; under: number | null } | null }
async function scoreboard(lg: string, date: string): Promise<Ev[]> {
  const d = await safe<any>(`${ESPN}/${lg}/scoreboard?dates=${ymd(date)}`, { events: [] });
  return (d.events || []).map((e: any) => {
    const c = e.competitions?.[0] || {}, H = c.competitors?.find((x: any) => x.homeAway === 'home'), A = c.competitors?.find((x: any) => x.homeAway === 'away');
    const st = c.status?.type || {}, o = c.odds?.[0], ml = o?.moneyline;
    const odds = o ? { c1: am2dec(ml?.home?.close?.odds ?? ml?.home?.open?.odds), cX: am2dec(ml?.draw?.close?.odds ?? o?.drawOdds?.moneyLine), c2: am2dec(ml?.away?.close?.odds ?? ml?.away?.open?.odds),
      line: o.overUnder ?? null, over: am2dec(o.total?.over?.close?.odds ?? o.total?.over?.open?.odds), under: am2dec(o.total?.under?.close?.odds ?? o.total?.under?.open?.odds) } : null;
    return { id: String(e.id), lg, utc: e.date, dom: H?.team?.shortDisplayName || H?.team?.displayName, ext: A?.team?.shortDisplayName || A?.team?.displayName, domId: String(H?.team?.id), extId: String(A?.team?.id),
      etat: st.state || 'pre', done: !!st.completed, hs: st.state !== 'pre' && H?.score != null ? +H.score : null, as: st.state !== 'pre' && A?.score != null ? +A.score : null, odds } as Ev;
  }).filter((x: Ev) => x.dom && x.ext);
}

/** Toutes les probabilités d'un match à partir des buts attendus (léger surplus de nuls). */
export function markets(lh: number, la: number) {
  const N = 11; let s = 0; const M: number[][] = [];
  for (let i = 0; i < N; i++) { M[i] = []; for (let j = 0; j < N; j++) { const q = pois(i, lh) * pois(j, la) * (i === j ? 1 + P.tau : 1); M[i][j] = q; s += q; } }
  let ph = 0, pd = 0, pa = 0, btts = 0; const tot = new Array(2 * N).fill(0);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const q = M[i][j] / s; if (i > j) ph += q; else if (i < j) pa += q; else pd += q; if (i && j) btts += q; tot[i + j] += q; }
  const over = (l: number) => tot.reduce((t, q, k) => t + (k > l ? q : 0), 0);
  return { lh, la, ph, pd, pa, btts, o15: over(1.5), o25: over(2.5), o35: over(3.5) };
}
/** Buts attendus implicites des cotes : total (plus/moins) puis répartition (1 contre 2). */
function marketLambdas(o: NonNullable<Ev['odds']>, muModel: number) {
  if (!o.c1 || !o.c2 || !o.cX) return null;
  const s = 1 / o.c1 + 1 / o.cX + 1 / o.c2, p1 = 1 / o.c1 / s, p2 = 1 / o.c2 / s;
  let mu = muModel;
  if (o.line != null && o.over && o.under) {
    const po = (1 / o.over) / (1 / o.over + 1 / o.under);
    let lo = 0.8, hi = 6;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2, mk = markets(m / 2, m / 2), pov = o.line === 1.5 ? mk.o15 : o.line === 3.5 ? mk.o35 : mk.o25; if (pov < po) lo = m; else hi = m; }
    mu = (lo + hi) / 2;
  }
  let a = 0.1, b = 0.9;
  for (let i = 0; i < 40; i++) { const x = (a + b) / 2, mk = markets(x * mu, (1 - x) * mu); if (mk.ph / (mk.ph + mk.pa) < p1 / (p1 + p2)) a = x; else b = x; }
  const x = (a + b) / 2;
  return { lh: x * mu, la: (1 - x) * mu, p1, pX: 1 - p1 - p2, p2 };
}
function list(dom: string, ext: string, mk: ReturnType<typeof markets>) {
  return [
    { code: '1', label: `${dom} gagne`, p: mk.ph }, { code: 'X', label: 'Match nul', p: mk.pd }, { code: '2', label: `${ext} gagne`, p: mk.pa },
    { code: '1X', label: `${dom} ou nul`, p: mk.ph + mk.pd }, { code: 'X2', label: `${ext} ou nul`, p: mk.pa + mk.pd }, { code: '12', label: 'Pas de match nul', p: mk.ph + mk.pa },
    { code: 'o15', label: 'Plus de 1,5 but', p: mk.o15 }, { code: 'u15', label: 'Moins de 1,5 but', p: 1 - mk.o15 },
    { code: 'o25', label: 'Plus de 2,5 buts', p: mk.o25 }, { code: 'u25', label: 'Moins de 2,5 buts', p: 1 - mk.o25 },
    { code: 'o35', label: 'Plus de 3,5 buts', p: mk.o35 }, { code: 'u35', label: 'Moins de 3,5 buts', p: 1 - mk.o35 },
    { code: 'btts', label: 'Les deux équipes marquent', p: mk.btts }, { code: 'nbtts', label: 'Une équipe ne marque pas', p: 1 - mk.btts },
  ];
}
function bookOdds(o: Ev['odds'], code: string) {
  if (!o) return null;
  if (code === '1') return o.c1; if (code === 'X') return o.cX; if (code === '2') return o.c2;
  const L = o.line != null ? `${Math.round(o.line * 10)}` : '';
  if (code === `o${L}`) return o.over; if (code === `u${L}`) return o.under;
  return null;
}
export function grade(code: string, hs: number, as: number): number | null {
  const t = hs + as;
  switch (code) {
    case '1': return +(hs > as); case 'X': return +(hs === as); case '2': return +(as > hs);
    case '1X': return +(hs >= as); case 'X2': return +(as >= hs); case '12': return +(hs !== as);
    case 'o15': return +(t > 1.5); case 'u15': return +(t < 1.5); case 'o25': return +(t > 2.5); case 'u25': return +(t < 2.5);
    case 'o35': return +(t > 3.5); case 'u35': return +(t < 3.5); case 'btts': return +(hs > 0 && as > 0); case 'nbtts': return +!(hs > 0 && as > 0);
  }
  return null;
}
function calibrate(table: any[] | undefined, p: number) {
  const b = table?.find((x: any) => p >= x.lo && p < x.hi);
  if (!b || !b.n) return p;
  return clamp(p + (b.n / (b.n + 60)) * (b.reel - b.prevu), 0.02, 0.97);
}

export async function runFoot(opts: { trigger?: string; now?: Date } = {}) {
  const t0 = Date.now(), store = kv('foot');
  const now = opts.now || new Date(), today = parisDate(now), tomorrow = parisDate(new Date(now.getTime() + 86400000)), consulted = parisStamp(now);
  const y = +today.slice(0, 4), start = +today.slice(5, 7) >= 7 ? y : y - 1;
  const db: any = Object.assign({ predictions: [] as any[], runs: [] as any[] }, (await store.getJSON('db')) || {});

  // 1. classements (saison en cours et passée) et matchs d'aujourd'hui et demain
  const [cur, prev, evs] = await Promise.all([
    pool([...LEAGUES], 5, async L => [L.c, await standings(L.c)] as const),
    pool(LEAGUES.filter(L => !('cup' in L)), 5, async L => [L.c, await standings(L.c, start - 1)] as const),
    pool(LEAGUES.flatMap(L => [today, tomorrow].map(d => [L.c, d] as const)), 6, async ([c, d]) => scoreboard(c, d)),
  ]);
  const ST = Object.fromEntries(cur), PR = Object.fromEntries(prev);
  const src: Record<string, string> = { 'ESPN – calendriers, classements, résultats ; cotes DraftKings': `${consulted} (${cur.filter(([, r]) => r.length).length}/${LEAGUES.length} classements)` };

  // 2. forces : attaque et défense par rapport à la moyenne de la ligue, ramenées vers la saison passée
  const team: Record<string, { a: number; d: number; k: number; lg: string; gp: number }> = {};
  const rates: Record<string, any> = {};
  for (const L of LEAGUES) {
    const rows: Row[] = ST[L.c] || [];
    const gp = rows.reduce((t, r) => t + r.mj, 0), m = gp ? rows.reduce((t, r) => t + r.bp, 0) / gp : 1.35;
    const pr: Row[] = PR[L.c] || [], gpp = pr.reduce((t, r) => t + r.mj, 0), mp = gpp ? pr.reduce((t, r) => t + r.bp, 0) / gpp : m;
    const prior = Object.fromEntries(pr.map(r => [r.id, { rf: r.bp / Math.max(1, r.mj) / mp, ra: r.bc / Math.max(1, r.mj) / mp }]));
    const K = 'cup' in L ? 4 : P.K;
    const R = rows.map(r => {
      const p0 = prior[r.id], pf = m * (p0 ? 1 - P.wPrior + P.wPrior * p0.rf : 1), pa = m * (p0 ? 1 - P.wPrior + P.wPrior * p0.ra : 1);
      return { ...r, rf: (r.bp + K * pf) / (r.mj + K), ra: (r.bc + K * pa) / (r.mj + K) };
    });
    rates[L.c] = { m, R };
    if (!('cup' in L)) for (const r of R) team[r.id] = { a: r.rf / m, d: r.ra / m, k: L.k, lg: L.n, gp: r.mj };
  }
  // équipes de coupe d'Europe sans championnat suivi : forces tirées du classement de la coupe (niveau moyen 0,82)
  for (const L of LEAGUES.filter(l => 'cup' in l)) for (const r of rates[L.c].R) if (!team[r.id] || team[r.id].gp < 3) team[r.id] = { a: r.rf / rates[L.c].m, d: r.ra / rates[L.c].m, k: 0.82, lg: L.n, gp: r.mj };

  // 3. notation des paris en attente
  let graded = 0;
  const pend = db.predictions.filter((p: any) => p.resultat == null);
  const need = [...new Set(pend.map((p: any) => `${p.lgc}|${p.date}`))] as string[];
  const res = new Map<string, Ev>();
  await pool(need, 6, async k => { const [c, d] = k.split('|'); for (const dd of [d, parisDate(new Date(Date.parse(d + 'T12:00:00Z') - 86400000))]) for (const e of await scoreboard(c, dd)) if (e.done) res.set(e.id, e); });
  for (const e of evs.flat()) if (e.done) res.set(e.id, e);
  for (const p of pend) {
    const e = res.get(p.game_id);
    if (!e) { if (Date.parse(p.utc) < Date.now() - 4 * 86400000) { p.resultat = 'N/J'; graded++; } continue; }
    const g = grade(p.code, e.hs!, e.as!); if (g == null) continue;
    p.resultat = g; p.score = `${e.hs}-${e.as}`; graded++;
  }
  const calib: Record<string, any[]> = {};
  for (const p of db.predictions.filter((x: any) => x.resultat === 0 || x.resultat === 1)) {
    const t = calib[p.code] ||= [0.5, 0.6, 0.7, 0.8, 0.9].map((lo, i, a) => ({ lo, hi: a[i + 1] ?? 1.01, n: 0, prevu: 0, reel: 0 }));
    const b = t.find(x => p.prob_brute >= x.lo && p.prob_brute < x.hi);
    if (b) { b.prevu = (b.prevu * b.n + p.prob_brute) / (b.n + 1); b.reel = (b.reel * b.n + p.resultat) / (b.n + 1); b.n++; }
  }

  // 4. matchs à venir et paris à plus de 50 %
  const matchs: any[] = [], picks: any[] = [], newPreds: any[] = [], seen = new Set<string>();
  for (const e of evs.flat()) {
    if (seen.has(e.id) || e.etat !== 'pre' || Date.parse(e.utc) < now.getTime() - 5 * 60000) continue;
    seen.add(e.id);
    const L = LEAGUES.find(l => l.c === e.lg)!, cup = 'cup' in L;
    const h = team[e.domId], a = team[e.extId];
    if (!h || !a) continue;
    let lh: number, la: number;
    if (cup) { const kr = 0.92; lh = P.mCup * (h.a * h.k / kr) * (a.d * kr / a.k) * P.homeCup; la = P.mCup * (a.a * a.k / kr) * (h.d * kr / h.k) * P.awayCup; }
    else { const m = rates[L.c].m; lh = m * h.a * a.d * P.home; la = m * a.a * h.d * P.away; }
    lh = clamp(lh, 0.2, 4.5); la = clamp(la, 0.2, 4.5);
    const model = markets(lh, la);
    const mkL = e.odds ? marketLambdas(e.odds, lh + la) : null;
    if (mkL) { lh = Math.exp((1 - P.wMkt) * Math.log(lh) + P.wMkt * Math.log(mkL.lh)); la = Math.exp((1 - P.wMkt) * Math.log(la) + P.wMkt * Math.log(mkL.la)); }
    const mk = markets(lh, la);
    const all = list(e.dom, e.ext, mk).map(m => ({ ...m, brute: m.p, p: calibrate(calib[m.code], m.p) }));
    const fmt = (m: any) => { const c = bookOdds(e.odds, m.code); return { code: m.code, label: m.label, prob: r3(m.p), brute: r3(m.brute), cote_juste: r3(1 / m.p, 2), cote_min: r3(1.05 / m.p, 2), cote_book: c, valeur: c ? r3(m.p * c - 1) : null }; };
    const paris = all.filter(m => m.p > 0.5).sort((x, y) => y.p - x.p).map(fmt);
    const match = `${e.dom} – ${e.ext}`, heure = parisHM(e.utc);
    const why = [
      `Buts attendus : ${e.dom} ${mk.lh.toFixed(2)} – ${e.ext} ${mk.la.toFixed(2)}${mkL ? ` (mon modèle ${model.lh.toFixed(2)}–${model.la.toFixed(2)}, cotes ${mkL.lh.toFixed(2)}–${mkL.la.toFixed(2)}, poids des cotes ${Math.round(P.wMkt * 100)} %)` : ' (pas de cote disponible : modèle seul)'}.`,
      `${e.dom} : attaque ${Math.round(h.a * 100)} % et défense ${Math.round(h.d * 100)} % de la moyenne de ${h.lg} (${h.gp} matchs, 100 = moyenne, défense : plus bas = mieux).`,
      `${e.ext} : attaque ${Math.round(a.a * 100)} % et défense ${Math.round(a.d * 100)} % de la moyenne de ${a.lg} (${a.gp} matchs).`,
      cup ? `Coupe d'Europe : forces ajustées au niveau du championnat de chaque équipe (${h.lg} ${h.k}, ${a.lg} ${a.k}).` : `Avantage du terrain : +${Math.round((P.home - 1) * 100)} % de buts à domicile.`,
      mkL ? `Cotes DraftKings sans marge : ${e.dom} ${Math.round(mkL.p1 * 100)} %, nul ${Math.round(mkL.pX * 100)} %, ${e.ext} ${Math.round(mkL.p2 * 100)} %.` : '',
      `Résultat : ${e.dom} ${Math.round(mk.ph * 100)} %, nul ${Math.round(mk.pd * 100)} %, ${e.ext} ${Math.round(mk.pa * 100)} %.`,
    ].filter(Boolean);
    const m = { lg: L.n, game_id: e.id, match, dom: e.dom, ext: e.ext, heure, utc: e.utc, paris, why, public: null, page: null, books: e.odds ? ['DraftKings'] : [],
      p60: { dom: r3(mk.ph), nul: r3(mk.pd), ext: r3(mk.pa) }, buts: { dom: r3(mk.lh, 2), ext: r3(mk.la, 2) }, cotes: e.odds };
    matchs.push(m);
    for (const x of paris) picks.push({ ...x, lg: L.n, game_id: e.id, match, heure, utc: e.utc });
    const tracked = [...paris.slice(0, 3), ...paris.slice(3).filter(x => x.cote_book)];
    for (const x of tracked) newPreds.push({ date: parisDate(new Date(e.utc)), lg: L.n, lgc: L.c, game_id: e.id, match, utc: e.utc, code: x.code, label: x.label, prob: x.prob, prob_brute: x.brute, cote: x.cote_book, resultat: null });
  }
  const fresh = new Set(newPreds.map(p => p.game_id));
  db.predictions = db.predictions.filter((p: any) => !(p.resultat == null && fresh.has(p.game_id))).concat(newPreds).filter((p: any) => Date.parse(p.utc) > Date.now() - 200 * 86400000);
  db.runs = db.runs.concat([{ quand: consulted, declencheur: opts.trigger || 'manuel', duree_s: r3((Date.now() - t0) / 1000, 1) }]).slice(-200);
  await store.setJSON('db', db);

  // 5. bilan et page
  const done = db.predictions.filter((p: any) => p.resultat === 0 || p.resultat === 1);
  const gain = (xs: any[]) => { const w = xs.filter(p => p.cote); return w.length ? { n: w.length, gagnes: w.filter(p => p.resultat === 1).length, unites: r3(w.reduce((t, p) => t + (p.resultat ? p.cote - 1 : -1), 0), 2), rendement: r3(w.reduce((t, p) => t + (p.resultat ? p.cote - 1 : -1), 0) / w.length) } : null; };
  const grp = (f: (p: any) => string) => { const o: Record<string, any> = {}; for (const p of done) { const k = f(p); const b = o[k] ||= { cle: k, n: 0, gagnes: 0, prevu: 0 }; b.n++; b.gagnes += p.resultat; b.prevu += p.prob; } return Object.values(o).map((b: any) => ({ ...b, prevu: r3(b.prevu / b.n), reel: r3(b.gagnes / b.n) })); };
  const bands = (p: any) => p.prob >= 0.8 ? '80 % et plus' : p.prob >= 0.7 ? '70 à 80 %' : p.prob >= 0.6 ? '60 à 70 %' : '50 à 60 %';
  const leagues: any = {};
  for (const L of LEAGUES) {
    const { m, R } = rates[L.c];
    leagues[L.n] = { source: 'ESPN', n_matchs: matchs.filter(x => x.lg === L.n).length, moyenne: r3(m * 2, 2),
      classement: [...R].sort((x: any, y: any) => y.pts - x.pts || (y.bp - y.bc) - (x.bp - x.bc)).map((r: any) => ({ team: r.team, mj: r.mj, v: r.v, n: r.n, d: r.d, bp: r.bp, bc: r.bc, pts: r.pts, att: r3(r.rf, 2), def: r3(r.ra, 2), forme: [] })) };
  }
  const payload = {
    meta: { mode: 'ANALYSE', genere: consulted, soiree: today, sources: src, duree_s: r3((Date.now() - t0) / 1000, 1), note: 'Données ESPN (classements et calendriers officiels relayés) et cotes DraftKings affichées par ESPN.' },
    picks: picks.sort((a, b) => b.prob - a.prob), matchs: matchs.sort((a, b) => Date.parse(a.utc) - Date.parse(b.utc)), leagues,
    bilan: { total: { n: done.length, gagnes: done.filter((p: any) => p.resultat === 1).length, prevu: done.length ? r3(done.reduce((t: number, p: any) => t + p.prob, 0) / done.length) : null },
      par_ligue: grp(p => p.lg), par_niveau: grp(bands), par_marche: grp(p => p.label.replace(/^.+? (gagne|ou nul)$/, 'Équipe $1')), public: { tous: null, bonne_cote: null, mes_paris_a_la_cote: gain(done) } },
    public: [], contre: [], historique: db.predictions.filter((p: any) => p.resultat != null).slice(-150).reverse(), historique_public: [], backtest: {},
  };
  await store.setJSON('latest', payload);
  return { ok: true, duree_s: payload.meta.duree_s, log: [`${matchs.length} match(s) aujourd'hui et demain, ${picks.length} pari(s) à plus de 50 %`, `${graded} pari(s) noté(s)`] };
}
