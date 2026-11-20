p='netlify/functions/lib/europe/sportsru.mts'
s=open(p,encoding='utf8').read()
old="""    const st = decodeVueQuery(await r.text());
    return st ? readMatch(st) : null;"""
new="""    const html = await r.text(), st = decodeVueQuery(html);
    if (!st) return null;
    // première équipe du sondage (normalement l'équipe à domicile) : sert à vérifier le sens des données
    const first = (html.match(/poll-variant__name"[^>]*>([^<]+)</) || [])[1]?.trim() || null;
    return { ...readMatch(st), first };"""
if old in s:
    s=s.replace(old,new); open(p,'w',encoding='utf8').write(s)

p='netlify/functions/lib/europe/pipeline.mts'
s=open(p,encoding='utf8').read()
rep=[
("import * as M from './model.mts';", "import * as M from './model.mts';\nimport * as SR from './sportsru.mts';\nimport { pool } from '../util.mts';"),
("""    const khlRow = Object.fromEntries(khl.table.map(r => [r.team, r]));""",
"""    const khlRow = Object.fromEntries(khl.table.map(r => [r.team, r]));

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
    src['sports.ru – KHL, vote des internautes et cotes des bookmakers (page de chaque match)'] = nEx ? `${consulted} (${nEx} match(s))` : 'non disponible';"""),
("""    // 3. matchs du jour et du lendemain (heure de Paris), paris à plus de 50 %
    const tomorrow = parisDate(new Date(now.getTime() + 86400000));
    const leagues: any = {}, matchs: any[] = [], picks: any[] = [], newPreds: any[] = [];""",
"""    // 3. matchs du jour et du lendemain (heure de Paris), paris à plus de 50 %
    const leagues: any = {}, matchs: any[] = [], picks: any[] = [], newPreds: any[] = [], publics: any[] = [], contre: any[] = [];"""),
("""        const list = M.marketsList(g.dom, g.ext, mk).map(m => ({ ...m, brute: m.p, p: M.calibrate(calib[`${lg}|${m.code}`], m.p) })).filter(m => m.p > 0.5).sort((a, b) => b.p - a.p)
          .map(m => ({ code: m.code, label: m.label, prob: r3(m.p), brute: r3(m.brute), cote_juste: r3(1 / m.p, 2), cote_min: r3(1.05 / m.p, 2) }));""",
"""        const ex = extras[g.id];
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
        }"""),
("""        const m = { lg, game_id: g.id, match: `${g.dom} – ${g.ext}`, dom: g.dom, ext: g.ext, heure: parisHM(g.utc!), utc: g.utc, paris: list, why,""",
"""        const m = { lg, game_id: g.id, match: `${g.dom} – ${g.ext}`, dom: g.dom, ext: g.ext, heure: parisHM(g.utc!), utc: g.utc, paris: list, why, public: pub, page: ex?.url || null, books: ex?.odds?.books || [],"""),
("""        for (const x of list.slice(0, 3)) newPreds.push({ date: parisDate(new Date(g.utc!)), lg, game_id: g.id, match: m.match, utc: g.utc, code: x.code, label: x.label, prob: x.prob, prob_brute: x.brute, resultat: null,
          snap: lg === 'KHL' && khlRow[g.dom] && khlRow[g.ext] ? { id: g.id, dom: g.dom, ext: g.ext, h: khlRow[g.dom], a: khlRow[g.ext] } : undefined });""",
"""        const snap = lg === 'KHL' && khlRow[g.dom] && khlRow[g.ext] ? { id: g.id, dom: g.dom, ext: g.ext, h: khlRow[g.dom], a: khlRow[g.ext] } : undefined;
        for (const x of list.slice(0, 3)) newPreds.push({ date: parisDate(new Date(g.utc!)), lg, game_id: g.id, match: m.match, utc: g.utc, code: x.code, label: x.label, prob: x.prob, prob_brute: x.brute, cote: x.cote_book, resultat: null, snap });
        // suivi à part : le pari du camp choisi par le public (pour mesurer s'il rapporte vraiment à ces cotes)
        if (pub?.pari) newPreds.push({ date: parisDate(new Date(g.utc!)), lg, game_id: g.id, match: m.match, utc: g.utc, code: pub.pari.code, label: pub.pari.label, prob: pub.pari.prob, prob_brute: pub.pari.brute, cote: pub.pari.cote_book, bonne: pub.pari.bonne, public: true, resultat: null, snap });"""),
("""    const done = db.predictions.filter((p: any) => p.resultat === 0 || p.resultat === 1);""",
"""    const done = db.predictions.filter((p: any) => (p.resultat === 0 || p.resultat === 1) && !p.public);
    const doneP = db.predictions.filter((p: any) => (p.resultat === 0 || p.resultat === 1) && p.public);
    const gain = (xs: any[]) => { const w = xs.filter(p => p.cote); return w.length ? { n: w.length, gagnes: w.filter(p => p.resultat === 1).length, unites: r3(w.reduce((t, p) => t + (p.resultat ? p.cote - 1 : -1), 0), 2), rendement: r3(w.reduce((t, p) => t + (p.resultat ? p.cote - 1 : -1), 0) / w.length) } : null; };"""),
("""        par_ligue: grp(p => p.lg), par_niveau: grp(bands), par_marche: grp(p => p.label.replace(/^.+? (gagne|ou nul)/, 'Équipe $1')) },""",
"""        par_ligue: grp(p => p.lg), par_niveau: grp(bands), par_marche: grp(p => p.label.replace(/^.+? (gagne|ou nul)/, 'Équipe $1')),
        public: { tous: gain(doneP), bonne_cote: gain(doneP.filter((p: any) => p.bonne)), mes_paris_a_la_cote: gain(done) } },
      public: publics.sort((a, b) => (b.valeur ?? -9) - (a.valeur ?? -9)), contre,"""),
("""      historique: db.predictions.filter((p: any) => p.resultat != null).slice(-150).reverse().map(({ snap, ...p }: any) => p),""",
"""      historique: db.predictions.filter((p: any) => p.resultat != null && !p.public).slice(-150).reverse().map(({ snap, ...p }: any) => p),
      historique_public: db.predictions.filter((p: any) => p.resultat != null && p.public).slice(-80).reverse().map(({ snap, ...p }: any) => p),"""),
("""    return { ok: true, duree_s: payload.meta.duree_s, log: [`${matchs.length} match(s) à venir, ${picks.length} pari(s) à plus de 50 %`, `${graded} pari(s) noté(s)`] };""",
"""    return { ok: true, duree_s: payload.meta.duree_s, log: [`${matchs.length} match(s) à venir, ${picks.length} pari(s) à plus de 50 %`, `${publics.length} choix du public retenu(s)`, `${graded} pari(s) noté(s)`] };"""),
]
for a,b in rep:
    assert a in s, a[:70]
    s=s.replace(a,b)
open(p,'w',encoding='utf8').write(s)
print('ok')
