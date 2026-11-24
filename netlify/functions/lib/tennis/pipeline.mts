// Tennis ATP et WTA : classement Elo par surface (Tennis Abstract, mis à jour chaque semaine) et matchs ESPN.
// Chances de victoire = formule Elo sur la surface du tournoi ; en Grand Chelem masculin (3 sets gagnants), le favori est renforcé.
import { kv } from '../store.mts';
import { parisStamp, r3, safe, getText, pool } from '../util.mts';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/tennis';
const parisDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const parisHM = (iso: string) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)).replace(',', '');
const norm = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

interface Elo { nom: string; rang: number; elo: number; h: number; c: number; g: number }
async function eloTable(tour: 'atp' | 'wta'): Promise<Elo[]> {
  const html = await getText(`https://tennisabstract.com/reports/${tour}_elo_ratings.html`);
  if (!html) return [];
  const out: Elo[] = [];
  for (const row of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
    const c = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (c.length < 11 || !/^\d+$/.test(c[0])) continue;
    out.push({ nom: c[1], rang: +c[0], elo: +c[3], h: +c[6], c: +c[8], g: +c[10] });
  }
  return out;
}
const surfaceOf = (t: string) => /roland|garros|monte|madrid|rome|internazionali|barcelona|hamburg|buenos|rio|santiago|estoril|munich|geneva|lyon|bastad|gstaad|umag|kitzbuhel|bogota|rabat|palermo|prague|parma|strasbourg|charleston|clay|argentina open|iasi|bucharest/i.test(t) ? 'c'
  : /wimbledon|halle|queen|s-hertogenbosch|hertogenbosch|stuttgart|mallorca|eastbourne|newport|berlin|bad homburg|nottingham|birmingham|grass/i.test(t) ? 'g' : 'h';
const SURF: Record<string, string> = { h: 'dur', c: 'terre battue', g: 'gazon' };
const slam = (t: string) => /australian open|roland|french open|wimbledon|us open/i.test(t);
/** Probabilité de gagner en 3 sets gagnants à partir de celle en 2 sets gagnants. */
function bo5(p3: number) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const s = (lo + hi) / 2; if (s * s * (3 - 2 * s) < p3) lo = s; else hi = s; }
  const s = (lo + hi) / 2;
  return s ** 3 * (10 - 15 * s + 6 * s * s);
}

interface Match { id: string; tour: string; tournoi: string; tour_nom: string; utc: string; etat: string; done: boolean; j1: string; j2: string; w1: boolean | null }
async function scoreboard(tour: 'atp' | 'wta', date: string): Promise<Match[]> {
  const d = await safe<any>(`${ESPN}/${tour}/scoreboard?dates=${date.replace(/-/g, '')}`, { events: [] });
  const out: Match[] = [];
  for (const e of d.events || []) for (const gr of e.groupings || []) {
    if (!/singles/i.test(gr.grouping?.displayName || gr.grouping?.slug || 'singles')) continue;
    for (const c of gr.competitions || []) {
      const [a, b] = c.competitors || [];
      if (!a?.athlete || !b?.athlete) continue;
      const st = c.status?.type || {};
      out.push({ id: String(c.id), tour: tour.toUpperCase(), tournoi: e.name, tour_nom: c.round?.displayName || '', utc: c.date, etat: st.state || 'pre', done: !!st.completed,
        j1: a.athlete.displayName, j2: b.athlete.displayName, w1: st.completed ? !!a.winner : null });
    }
  }
  return out;
}

export async function runTennis(opts: { trigger?: string; now?: Date } = {}) {
  const t0 = Date.now(), store = kv('tennis');
  const now = opts.now || new Date(), today = parisDate(now), tomorrow = parisDate(new Date(now.getTime() + 86400000)), consulted = parisStamp(now);
  const db: any = Object.assign({ predictions: [] as any[], runs: [] as any[] }, (await store.getJSON('db')) || {});
  const [eA, eW] = await Promise.all([eloTable('atp'), eloTable('wta')]);
  const E: Record<string, Map<string, Elo>> = { ATP: new Map(), WTA: new Map() };
  for (const [k, T] of [['ATP', eA], ['WTA', eW]] as const) for (const x of T) { E[k].set(norm(x.nom), x); const p = norm(x.nom).split(' '); E[k].set(`${p[0][0]} ${p[p.length - 1]}`, x); }
  const find = (tour: string, nom: string) => { const n = norm(nom), p = n.split(' '); return E[tour].get(n) || E[tour].get(`${p[0]?.[0]} ${p[p.length - 1]}`) || null; };

  const days = [today, tomorrow];
  const pend = db.predictions.filter((p: any) => p.resultat == null);
  for (const p of pend) if (!days.includes(p.date)) days.push(p.date);
  const lists = await pool(days.flatMap(d => (['atp', 'wta'] as const).map(t => [t, d] as const)), 4, async ([t, d]) => scoreboard(t, d));
  const all = new Map<string, Match>(); for (const m of lists.flat()) all.set(m.id, m);

  // notation
  let graded = 0;
  for (const p of pend) {
    const m = all.get(p.game_id);
    if (!m?.done) { if (Date.parse(p.utc) < Date.now() - 4 * 86400000) { p.resultat = 'N/J'; graded++; } continue; }
    p.resultat = (p.joueur === m.j1) === !!m.w1 ? 1 : 0; graded++;
  }
  // matchs à venir
  const matchs: any[] = [], picks: any[] = [], newPreds: any[] = [];
  for (const m of all.values()) {
    if (m.etat !== 'pre' || !m.utc || Date.parse(m.utc) < now.getTime() - 5 * 60000 || ![today, tomorrow].includes(parisDate(new Date(m.utc)))) continue;
    if (/^tbd$/i.test(m.j1) || /^tbd$/i.test(m.j2)) continue;   // adversaire pas encore connu
    const a = find(m.tour, m.j1), b = find(m.tour, m.j2), s = surfaceOf(m.tournoi);
    if (!a || !b) { matchs.push({ lg: m.tour, game_id: m.id, match: `${m.j1} – ${m.j2}`, tournoi: m.tournoi, tour_nom: m.tour_nom, utc: m.utc, heure: parisHM(m.utc), surface: SURF[s], p1: null, p2: null, why: [`Pas de classement Elo pour ${!a ? m.j1 : m.j2} (moins de 10 matchs sur 52 semaines) : pas de pronostic.`] }); continue; }
    const ea = (a as any)[s] || a.elo, eb = (b as any)[s] || b.elo;
    let p1 = 1 / (1 + 10 ** ((eb - ea) / 400));
    const five = m.tour === 'ATP' && slam(m.tournoi);
    if (five) p1 = p1 >= 0.5 ? bo5(p1) : 1 - bo5(1 - p1);
    const fav = p1 >= 0.5 ? m.j1 : m.j2, pf = Math.max(p1, 1 - p1);
    const why = [`Elo ${SURF[s]} : ${m.j1} ${Math.round(ea)} (n° ${a.rang} Elo général) contre ${m.j2} ${Math.round(eb)} (n° ${b.rang}).`,
      `Écart de ${Math.abs(Math.round(ea - eb))} points${five ? ', en 3 sets gagnants (le favori est plus sûr)' : ''} : ${fav} gagne ${Math.round(pf * 100)} % du temps.`];
    const x = { lg: m.tour, game_id: m.id, match: `${m.j1} – ${m.j2}`, tournoi: m.tournoi, tour_nom: m.tour_nom, heure: parisHM(m.utc), utc: m.utc, surface: SURF[s], p1: r3(p1), p2: r3(1 - p1), why };
    matchs.push(x);
    const pick = { lg: m.tour, game_id: m.id, match: x.match, tournoi: m.tournoi, heure: x.heure, utc: m.utc, label: `${fav} gagne`, joueur: fav, prob: r3(pf), cote_juste: r3(1 / pf, 2), cote_min: r3(1.05 / pf, 2) };
    picks.push(pick);
    newPreds.push({ ...pick, date: parisDate(new Date(m.utc)), resultat: null });
  }
  const fresh = new Set(newPreds.map(p => p.game_id));
  db.predictions = db.predictions.filter((p: any) => !(p.resultat == null && fresh.has(p.game_id))).concat(newPreds).filter((p: any) => Date.parse(p.utc) > Date.now() - 200 * 86400000);
  db.runs = db.runs.concat([{ quand: consulted, declencheur: opts.trigger || 'manuel' }]).slice(-200);
  await store.setJSON('db', db);
  const done = db.predictions.filter((p: any) => p.resultat === 0 || p.resultat === 1);
  const payload = {
    meta: { genere: consulted, soiree: today, sources: { 'Tennis Abstract – classements Elo par surface (hebdomadaires)': eA.length + eW.length ? `${consulted} (${eA.length} ATP, ${eW.length} WTA)` : 'non disponible', 'ESPN – tableaux et résultats ATP/WTA': consulted } },
    matchs: matchs.sort((a, b) => Date.parse(a.utc) - Date.parse(b.utc)), picks: picks.sort((a, b) => b.prob - a.prob),
    bilan: { n: done.length, gagnes: done.filter((p: any) => p.resultat === 1).length, prevu: done.length ? r3(done.reduce((t: number, p: any) => t + p.prob, 0) / done.length) : null },
    historique: db.predictions.filter((p: any) => p.resultat != null).slice(-100).reverse(),
    elo: { ATP: eA.slice(0, 30), WTA: eW.slice(0, 30) },
  };
  await store.setJSON('latest', payload);
  return { ok: true, log: [`${matchs.length} match(s) de simple aujourd'hui et demain, ${picks.length} pronostic(s)`, `${graded} pari(s) noté(s)`] };
}
