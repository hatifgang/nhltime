// Hockey européen (KHL, SHL, Liiga) : seulement les paris à plus de 50 % de chances, notés chaque jour.
import { kv } from '../store.mts';
import { parisStamp, r3, clamp } from '../util.mts';
import * as S from './sources.mts';
import * as M from './model.mts';
import * as SR from './sportsru.mts';
import { pool } from '../util.mts';
import seed from './seed.json' with { type: 'json' };

const LGS = ['KHL', 'SHL', 'Liiga'] as const;
const SOURCE: Record<string, string> = { KHL: 'sports.ru (calendrier et classement KHL)', SHL: 'shl.se (site officiel)', Liiga: 'liiga.fi (site officiel)' };
const parisDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const parisHM = (iso: string) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)).replace(',', '');

/** KHL : pas de détail match par match accessible pour la saison en cours → forces tirées du classement (buts hors prolongation). */
function ratesFromTable(table: S.ERow[], prior: Record<string, any>, P: M.EParams) {
  const Lp = (seed as any).ligues.KHL;
  const gp = table.reduce((t, r) => t + r.mj, 0) || 1;
  const m = table.reduce((t, r) => t + (r.bp - r.vo), 0) / gp;
  const L = { n: gp / 2, m, H: m * Lp.H / Lp.m, A: m * Lp.A / Lp.m, ties: Lp.ties };
  const T: Record<string, M.TeamRate> = {};
  for (const r of table) {
    const pr = prior[r.team], pf = pr ? m * (1 - P.wPrior + P.wPrior * pr.rf) : m, pa = pr ? m * (1 - P.wPrior + P.wPrior * pr.ra) : m;
    T[r.team] = { team: r.team, gp: r.mj, gf: r.bp - r.vo, ga: r.bc - r.dp, rf: (r.bp - r.vo + P.K * pf) / (r.mj + P.K), ra: (r.bc - r.dp + P.K * pa) / (r.mj + P.K), form: [] };
  }
  return { L, T };
}
/** Résultat KHL reconstitué par différence de classement entre la prise de vue au moment du pari et maintenant. */
function khlResult(snap: any, now: Record<string, S.ERow>): S.EGame | 'NJ' | null {
  const h = now[snap.dom], a = now[snap.ext];
  if (!h || !a) return null;
  const dh = h.mj - snap.h.mj, da = a.mj - snap.a.mj;
  if (dh === 0 && da === 0) return null;
  if (dh !== 1 || da !== 1) return 'NJ';   // un autre match joué entre-temps : impossible d'isoler le score
  let hs = h.bp - snap.h.bp, as = a.bp - snap.a.bp;
  const otH = (h.vo - snap.h.vo) + (h.dp - snap.h.dp), otA = (a.vo - snap.a.vo) + (a.dp - snap.a.dp);
  const winH = h.v - snap.h.v === 1;
  if (hs === as && (otH || otA)) { if (winH) hs++; else as++; }   // tirs au but : le but décisif compte au score final
  return { lg: 'KHL', id: snap.id, date: '', utc: null, dom: snap.dom, ext: snap.ext, done: true, hs, as, fin: otH || otA ? 'OT' : 'REG' };
}
function standings(games: S.EGame[]) {
  const T: Record<string, any> = {};
  for (const g of games.filter(x => x.done)) for (const [t, f, c] of [[g.dom, g.hs!, g.as!], [g.ext, g.as!, g.hs!]] as const) {
    const r = T[t] ||= { team: t, mj: 0, v: 0, vo: 0, d: 0, dp: 0, bp: 0, bc: 0 };
    r.mj++; r.bp += f; r.bc += c;
    if (f > c) { r.v++; if (g.fin !== 'REG') r.vo++; } else { r.d++; if (g.fin !== 'REG') r.dp++; }
  }
  return Object.values(T).map(r => ({ ...r, pts: 3 * (r.v - r.vo) + 2 * r.vo + r.dp })).sort((a, b) => b.pts / b.mj - a.pts / a.mj);
}

export async function runEurope(opts: { trigger?: string; now?: Date } = {}) {
  const t0 = Date.now(), store = kv('europe');
  const lock = await store.getJSON('lock');
  if (lock && Date.now() - lock.t < 90000) return { ok: false, busy: true, message: 'Une analyse est déjà en cours, réessaie dans une minute.' };
  await store.setJSON('lock', { t: Date.now() });
  try {
    const now = opts.now || new Date(), today = parisDate(now), consulted = parisStamp(now);
    const y = +today.slice(0, 4), start = +today.slice(5, 7) >= 8 ? y : y - 1;
    const db: any = Object.assign({ predictions: [] as any[], runs: [] as any[] }, (await store.getJSON('db')) || {});
    const P: M.EParams = { ...(seed as any).params };
    const [khl, shl, liiga] = await Promise.all([S.khlNow(start), S.shlSeason(String(start)), S.liigaSeason(start + 1)]);
    const src: Record<string, string> = {
      'sports.ru – KHL (calendrier, classement)': khl.ok ? consulted : 'non disponible',
      'shl.se – SHL, site officiel (calendrier, résultats)': shl.length ? consulted : 'non disponible',
      'liiga.fi – Liiga, site officiel (calendrier, résultats)': liiga.length ? consulted : 'non disponible',
    };
    const khlRow = Object.fromEntries(khl.table.map(r => [r.team, r]));

    // 0. KHL : vote des internautes sports.ru (« Qui va gagner ? ») et cotes des bookmakers, page de chaque match (budget 10 s)
    const tomorrow = parisDate(new Date(now.getTime() + 86400000));
    const soon = (g: S.EGame) => !g.done && !!g.utc && Date.parse(g.utc) > now.getTime() - 5 * 60000 && [today, tomorrow].includes(parisDate(new Date(g.utc)));
    const tEx = Date.now(), extras: Record<string, any> = {};
    await pool(khl.upcoming.filter(soon), 6, async (g: S.EGame) => {
      const url = (khl as any).pages?.[`${g.date}|${g.dom}|${g.ext}`];
      if (!url) return;
      const x = await SR.khlMatchExtras(url, 10000 - (Date.now() - tEx));
      if (!x) return;
      if (x.first && S.KHL_FR[x.first] && S.KHL_FR[x.first] !== g.dom) return;   // sens domicile/extérieur douteux : on n'utilise pas
      extras[g.id] = { ...x, url };
    });
    const nEx = Object.keys(extras).length;
    src['sports.ru – KHL, vote des internautes et cotes des bookmakers (page de chaque match)'] = nEx ? `${consulted} (${nEx} match(s))` : 'non disponible';
    const byId = new Map<string, S.EGame>([...shl, ...liiga].map(g => [g.id, g]));

    // 1. notation des paris en attente
    let graded = 0;
    for (const p of db.predictions) {
      if (p.resultat != null) continue;
      let g: S.EGame | 'NJ' | null | undefined = null;
      if (p.lg === 'KHL') g = p.snap ? khlResult(p.snap, khlRow) : null; else g = byId.get(p.game_id);
      if (g === 'NJ') { p.resultat = 'N/J'; graded++; continue; }
      if (!g || !g.done) { if (Date.parse(p.utc || p.date) < Date.now() - 4 * 86400000) { p.resultat = 'N/J'; graded++; } continue; }
      const res = M.gradeMarket(p.code, g);
      if (res == null) continue;
      p.resultat = res; p.score = `${g.hs}-${g.as}${g.fin !== 'REG' ? ' (' + (g.fin === 'SO' ? 'tirs au but' : 'prol.') + ')' : ''}`; graded++;
    }

    // 2. recalage : saison passée rejouée + paris notés en direct
    const calib: Record<string, any[]> = JSON.parse(JSON.stringify((seed as any).calib));
    for (const p of db.predictions.filter((x: any) => x.resultat === 0 || x.resultat === 1)) {
      const k = `${p.lg}|${p.code}`, b = (calib[k] ||= []).find((x: any) => p.prob_brute >= x.lo && p.prob_brute < x.hi);
      if (b) { b.prevu = (b.prevu * b.n + p.prob_brute) / (b.n + 1); b.reel = (b.reel * b.n + p.resultat) / (b.n + 1); b.n++; }
    }

    // 3. matchs du jour et du lendemain (heure de Paris), paris à plus de 50 %
    const leagues: any = {}, matchs: any[] = [], picks: any[] = [], newPreds: any[] = [], publics: any[] = [], contre: any[] = [];
    for (const lg of LGS) {
      const season = lg === 'KHL' ? null : lg === 'SHL' ? shl : liiga;
      const prior = (seed as any).priors[lg] || {};
      const R = lg === 'KHL' ? ratesFromTable(khl.table, prior, P) : M.teamRates(season!.filter(g => g.done), prior, P);
      const upcoming = (lg === 'KHL' ? khl.upcoming : season!).filter(g => !g.done && g.utc && Date.parse(g.utc) > now.getTime() - 5 * 60000)
        .filter(g => { const d = parisDate(new Date(g.utc!)); return d === today || d === tomorrow; });
      const table = lg === 'KHL' ? khl.table.map(r => ({ ...r })) : standings(season!);
      leagues[lg] = { source: SOURCE[lg], n_matchs: upcoming.length, classement: table.map(r => ({ ...r, forme: R.T[r.team]?.form || [], att: r3(R.T[r.team]?.rf, 2), def: r3(R.T[r.team]?.ra, 2) })), moyenne: r3(R.L.m * 2, 2) };
      for (const g of upcoming) {
        const mk = M.predict(R, g.dom, g.ext, P);
        if (!mk) continue;
        const ex = extras[g.id];
        const all = M.marketsList(g.dom, g.ext, mk).map(m => ({ ...m, brute: m.p, p: M.calibrate(calib[`${lg}|${m.code}`], m.p) }));
        const fmt = (m: any) => { const c = SR.bookOdds(ex?.odds, m.code); return { code: m.code, label: m.label, prob: r3(m.p), brute: r3(m.brute), cote_juste: r3(1 / m.p, 2), cote_min: r3(1.05 / m.p, 2), cote_book: c, valeur: c ? r3(m.p * c - 1) : null }; };
        const list = all.filter(m => m.p > 0.5).sort((a, b) => b.p - a.p).map(fmt);
        // ce que jouent les autres parieurs : le camp choisi par la majorité des internautes (au moins 10 votes)
        let pub: any = null;
        if (ex?.crowd && ex.crowd.votes >= 10 && Math.max(ex.crowd.dom, ex.crowd.ext) > ex.crowd.nul) {
          const side = ex.crowd.dom >= ex.crowd.ext ? 'dom' : 'ext', team = side === 'dom' ? g.dom : g.ext;
          const cands = all.filter(m => (side === 'dom' ? ['1', '1X'] : ['2', 'X2']).includes(m.code)).map(fmt);
          const ok = cands.filter(m => m.prob > 0.5 && m.cote_book).sort((a, b) => b.valeur! - a.valeur!);
          pub = { equipe: team, part: r3(ex.crowd[side]), votes: ex.crowd.votes, vote: { dom: r3(ex.crowd.dom), nul: r3(ex.crowd.nul), ext: r3(ex.crowd.ext) } };
          if (ok.length) { pub.pari = { ...ok[0], bonne: ok[0].cote_book! >= ok[0].cote_min }; publics.push({ ...pub, ...pub.pari, lg, game_id: g.id, match: `${g.dom} – ${g.ext}`, heure: parisHM(g.utc!), utc: g.utc }); }
          else { const w = cands.find(m => m.code === (side === 'dom' ? '1' : '2')); contre.push({ ...pub, lg, match: `${g.dom} – ${g.ext}`, heure: parisHM(g.utc!), utc: g.utc, prob_victoire: w?.prob, cote: w?.cote_book }); }
        }
        const h = R.T[g.dom], a = R.T[g.ext];
        const why = [`Buts attendus en 60 min : ${g.dom} ${mk.lh.toFixed(2)} – ${g.ext} ${mk.la.toFixed(2)} (moyenne de la ligue ${(R.L.m * 2).toFixed(2)} par match).`,
          `${g.dom} : ${h.gp} matchs, ${(h.gf / Math.max(1, h.gp)).toFixed(2)} buts marqués et ${(h.ga / Math.max(1, h.gp)).toFixed(2)} encaissés par match${h.form.length ? `, forme ${h.form.join('')}` : ''}.`,
          `${g.ext} : ${a.gp} matchs, ${(a.gf / Math.max(1, a.gp)).toFixed(2)} buts marqués et ${(a.ga / Math.max(1, a.gp)).toFixed(2)} encaissés par match${a.form.length ? `, forme ${a.form.join('')}` : ''}.`,
          `60 min : ${g.dom} ${Math.round(mk.ph * 100)} %, nul ${Math.round(mk.pd * 100)} %, ${g.ext} ${Math.round(mk.pa * 100)} %.`];
        const m = { lg, game_id: g.id, match: `${g.dom} – ${g.ext}`, dom: g.dom, ext: g.ext, heure: parisHM(g.utc!), utc: g.utc, paris: list, why, public: pub, page: ex?.url || null, books: ex?.odds?.books || [],
          p60: { dom: r3(mk.ph), nul: r3(mk.pd), ext: r3(mk.pa) }, buts: { dom: r3(mk.lh, 2), ext: r3(mk.la, 2) } };
        matchs.push(m);
        for (const x of list) picks.push({ ...x, lg, game_id: g.id, match: m.match, heure: m.heure, utc: g.utc });
        // suivi : les 3 paris les plus probables de chaque match
        const snap = lg === 'KHL' && khlRow[g.dom] && khlRow[g.ext] ? { id: g.id, dom: g.dom, ext: g.ext, h: khlRow[g.dom], a: khlRow[g.ext] } : undefined;
        for (const x of list.slice(0, 3)) newPreds.push({ date: parisDate(new Date(g.utc!)), lg, game_id: g.id, match: m.match, utc: g.utc, code: x.code, label: x.label, prob: x.prob, prob_brute: x.brute, cote: x.cote_book, resultat: null, snap });
        // suivi à part : le pari du camp choisi par le public (pour mesurer s'il rapporte vraiment à ces cotes)
        if (pub?.pari) newPreds.push({ date: parisDate(new Date(g.utc!)), lg, game_id: g.id, match: m.match, utc: g.utc, code: pub.pari.code, label: pub.pari.label, prob: pub.pari.prob, prob_brute: pub.pari.brute, cote: pub.pari.cote_book, bonne: pub.pari.bonne, public: true, resultat: null, snap });
      }
    }
    const fresh = new Set(newPreds.map(p => p.game_id));
    db.predictions = db.predictions.filter((p: any) => !(p.resultat == null && fresh.has(p.game_id))).concat(newPreds)
      .filter((p: any) => Date.parse(p.utc || p.date) > Date.now() - 200 * 86400000);
    db.runs = db.runs.concat([{ quand: consulted, declencheur: opts.trigger || 'manuel', duree_s: r3((Date.now() - t0) / 1000, 1) }]).slice(-200);
    await store.setJSON('db', db);

    // 4. bilan
    const done = db.predictions.filter((p: any) => (p.resultat === 0 || p.resultat === 1) && !p.public);
    const doneP = db.predictions.filter((p: any) => (p.resultat === 0 || p.resultat === 1) && p.public);
    const gain = (xs: any[]) => { const w = xs.filter(p => p.cote); return w.length ? { n: w.length, gagnes: w.filter(p => p.resultat === 1).length, unites: r3(w.reduce((t, p) => t + (p.resultat ? p.cote - 1 : -1), 0), 2), rendement: r3(w.reduce((t, p) => t + (p.resultat ? p.cote - 1 : -1), 0) / w.length) } : null; };
    const grp = (f: (p: any) => string) => { const o: Record<string, any> = {}; for (const p of done) { const k = f(p); const b = o[k] ||= { cle: k, n: 0, gagnes: 0, prevu: 0 }; b.n++; b.gagnes += p.resultat; b.prevu += p.prob; } return Object.values(o).map((b: any) => ({ ...b, prevu: r3(b.prevu / b.n), reel: r3(b.gagnes / b.n) })); };
    const bands = (p: any) => p.prob >= 0.8 ? '80 % et plus' : p.prob >= 0.7 ? '70 à 80 %' : p.prob >= 0.6 ? '60 à 70 %' : '50 à 60 %';
    const payload = {
      meta: { mode: 'ANALYSE', genere: consulted, soiree: today, sources: src, duree_s: r3((Date.now() - t0) / 1000, 1),
        note: "khl.ru refuse les programmes automatiques : la KHL vient de sports.ru (grand média sportif russe). Pour la saison en cours, les forces KHL viennent du classement (buts marqués et encaissés hors prolongation)." },
      picks: picks.sort((a, b) => b.prob - a.prob), matchs: matchs.sort((a, b) => Date.parse(a.utc) - Date.parse(b.utc)), leagues,
      bilan: { total: { n: done.length, gagnes: done.filter((p: any) => p.resultat === 1).length, prevu: done.length ? r3(done.reduce((t: number, p: any) => t + p.prob, 0) / done.length) : null },
        par_ligue: grp(p => p.lg), par_niveau: grp(bands), par_marche: grp(p => p.label.replace(/^.+? (gagne|ou nul)/, 'Équipe $1')),
        public: { tous: gain(doneP), bonne_cote: gain(doneP.filter((p: any) => p.bonne)), mes_paris_a_la_cote: gain(done) } },
      public: publics.sort((a, b) => (b.valeur ?? -9) - (a.valeur ?? -9)), contre,
      historique: db.predictions.filter((p: any) => p.resultat != null && !p.public).slice(-150).reverse().map(({ snap, ...p }: any) => p),
      historique_public: db.predictions.filter((p: any) => p.resultat != null && p.public).slice(-80).reverse().map(({ snap, ...p }: any) => p),
      backtest: { KHL: 748, SHL: 364, Liiga: 480 },
    };
    await store.setJSON('latest', payload);
    return { ok: true, duree_s: payload.meta.duree_s, log: [`${matchs.length} match(s) à venir, ${picks.length} pari(s) à plus de 50 %`, `${publics.length} choix du public retenu(s)`, `${graded} pari(s) noté(s)`] };
  } finally { await store.del('lock'); }
}
