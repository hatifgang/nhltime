def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for o, n in pairs:
        assert o in s, (path, o[:80])
        s = s.replace(o, n, 1)
    open(path, 'w', encoding='utf-8').write(s)


AVIS = """(notre: number | null, ev: number | null) => { const pc = notre != null ? Math.round(notre * 100) : null; return pc == null ? "Je n'ai pas d'estimation sur ce pari." : pc >= 50 ? (ev != null && ev < 0 ? `D'accord sur le fond (${pc} %) mais la cote est un peu courte.` : `Je suis d'accord : ${pc} % selon moi.`) : `Je ne suis pas d'accord : ${pc} % selon moi.`; }"""

# section commune (calcul) : appelée avec une fonction de probabilité propre à chaque ligue
SECTION = """  // ---- OLBG : consensus des tipsters et pari du meilleur tipster de chaque match, avec mon avis
  const olbgAvis = """ + AVIS + """;
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
"""

# ---------------------------------------------------------------- NHL
patch('netlify/functions/lib/pipeline.mts', [
    ("import { fetchCovers, fetchTopBettors } from './covers.mts';", "import { fetchCovers, fetchTopBettors } from './covers.mts';\nimport { fetchOlbg, legLabel } from './olbg.mts';"),
    ("""  const cov = games.length ? await fetchCovers(placeToAbbr) : { ok: false, reason: 'aucun match', games: [] as any[] };
  const covBy = new Map(cov.games.map((c: any) => [`${c.away}@${c.home}`, c]));
  const tb = games.length ? await fetchTopBettors(placeToAbbr) : { ok: false, reason: '', parieurs: [] as any[], paris: [] as any[], n_classes: 0, seuil_chance: 0 };""",
     """  const nickOf: Record<string, string> = Object.fromEntries(ctx.abbrs.map(ab => [ab, nm(ctx.st[ab].teamCommonName)]));
  const [cov, tb, OL] = await Promise.all([   // en parallèle : Covers et OLBG ne doivent pas rallonger l'analyse
    games.length ? fetchCovers(placeToAbbr) : Promise.resolve({ ok: false, reason: 'aucun match', games: [] as any[] }),
    games.length ? fetchTopBettors(placeToAbbr) : Promise.resolve({ ok: false, reason: '', parieurs: [] as any[], paris: [] as any[], n_classes: 0, seuil_chance: 0 }),
    games.length ? fetchOlbg('nhl', games.map((g: any) => ({ ext: g.awayTeam.abbrev, dom: g.homeTeam.abbrev })), nickOf).catch(() => ({ ok: false, reason: 'olbg.com inaccessible', games: [] as any[] })) : Promise.resolve({ ok: false, reason: 'aucun match', games: [] as any[] }),
  ]);
  const covBy = new Map(cov.games.map((c: any) => [`${c.away}@${c.home}`, c]));
  const olbgInfo = OL.ok ? `${ctx.consulted} (${OL.games.length} match(s))` : `non disponible (${OL.reason})`;"""),
    ("  selection.top5 = { parieurs: top5, n_classes: tb.n_classes, seuil_chance: r3(tb.seuil_chance, 2) };\n",
     """  selection.top5 = { parieurs: top5, n_classes: tb.n_classes, seuil_chance: r3(tb.seuil_chance, 2) };
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
""" + SECTION + """  selection.olbg = olbg;
  for (const c of olbgTop) newPreds.push({ ...sbase(c.game_id), v: 2, type: 'Consensus OLBG', selection: `${c.label} (${c.n}/${c.total} tipsters)`, legs: [{ kind: c.leg.kind, team: c.leg.team, line: c.leg.line, game_id: c.game_id }], prob: c.notre ?? 0.5, cote: c.cote });
  for (const m of olbgMatchs) if (!m.commence && m.best) newPreds.push({ ...sbase(m.game_id), v: 2, type: 'Pari tipster OLBG', parieur: m.best.tipster, selection: `${m.best.tipster} : ${m.best.label}`, legs: [{ kind: m.best.leg.kind, team: m.best.leg.team, line: m.best.leg.line, game_id: m.game_id }], prob: m.best.notre ?? 0.5, cote: m.best.cote });
"""),
    ("  if (kind === 'over') return tot === l.line ? null : +(tot > l.line);",
     "  if (kind === 'spread') { const m = (l.team === h.abbrev ? h.score - a.score : a.score - h.score) + l.line; return m === 0 ? null : +(m > 0); }\n  if (kind === 'over') return tot === l.line ? null : +(tot > l.line);"),
    ("['top5', 'Pari top Covers'],", "['top5', 'Pari top Covers'], ['olbg_top', 'Consensus OLBG'], ['olbg_best', 'Pari tipster OLBG'],"),
    ("'Pari parieur Covers', 'Pari top Covers'];", "'Pari parieur Covers', 'Pari top Covers', 'Consensus OLBG', 'Pari tipster OLBG'];"),
    ("          'covers.com – public et leaders (à vérifier)': evening.coversInfo,", "          'covers.com – public et leaders (à vérifier)': evening.coversInfo,\n          'olbg.com – tipsters (à vérifier)': evening.olbgInfo,"),
    ("  return { games: outGames, players: outPlayers, injuries, lineupInfo, oddsInfo, selection, coversInfo };", "  return { games: outGames, players: outPlayers, injuries, lineupInfo, oddsInfo, selection, coversInfo, olbgInfo };"),
])

# ---------------------------------------------------------------- NBA
patch('netlify/functions/lib/nba/pipeline.mts', [
    ("import { fetchCovers, fetchTopBettors } from '../covers.mts';", "import { fetchCovers, fetchTopBettors } from '../covers.mts';\nimport { fetchOlbg } from '../olbg.mts';"),
    ("  const [games, inj, lu, cov, tb] = await Promise.all([\n    E.scoreboard(today), E.injuries(), E.nbaLineups(today),",
     "  const sbToday = await E.scoreboard(today);\n  const nickNba: Record<string, string> = Object.fromEntries(Object.entries(E.TEAM_NAMES).map(([k, v]) => [k, v]));\n  const [games, inj, lu, cov, tb, OL] = await Promise.all([\n    Promise.resolve(sbToday), E.injuries(), E.nbaLineups(today),"),
    ("    fetchTopBettors(E.PLACE, 10, 'nba').catch(() => ({ ok: false, reason: '', parieurs: [] as any[], paris: [] as any[], n_classes: 0, seuil_chance: 3 })),\n  ]);",
     "    fetchTopBettors(E.PLACE, 10, 'nba').catch(() => ({ ok: false, reason: '', parieurs: [] as any[], paris: [] as any[], n_classes: 0, seuil_chance: 3 })),\n    sbToday.length ? fetchOlbg('nba', sbToday.map(g => ({ ext: g.ext, dom: g.dom })), nickNba).catch(() => ({ ok: false, reason: 'olbg.com inaccessible', games: [] as any[] })) : Promise.resolve({ ok: false, reason: 'aucun match', games: [] as any[] }),\n  ]);\n  const olbgInfo = OL.ok ? `${consulted} (${OL.games.length} match(s))` : `non disponible (${OL.reason})`;"),
    ("  const selection = buildSelection(outGames, outPlayers, started, db, params, tb, cov);", "  const selection = buildSelection(outGames, outPlayers, started, db, params, tb, cov, OL);"),
    ("  return { games: outGames, players: outPlayers, injuries, lineups, selection, oddsInfo, lineupInfo, coversInfo, conflits };", "  return { games: outGames, players: outPlayers, injuries, lineups, selection, oddsInfo, lineupInfo, coversInfo, olbgInfo, conflits };"),
    ("          'covers.com – public et leaders (à vérifier)': ev.coversInfo,", "          'covers.com – public et leaders (à vérifier)': ev.coversInfo,\n          'olbg.com – tipsters (à vérifier)': ev.olbgInfo,"),
])
patch('netlify/functions/lib/nba/selection.mts', [
    ("import * as M from './model.mts';", "import * as M from './model.mts';\nimport { legLabel } from '../olbg.mts';"),
    ("export function buildSelection(games: any[], players: any[], started: Set<string>, db: any, P: M.NbaParams, tb: any, cov: any) {",
     "export function buildSelection(games: any[], players: any[], started: Set<string>, db: any, P: M.NbaParams, tb: any, cov: any, OL: any = { ok: false, games: [] }) {"),
    ("  for (const a of autres) preds.push({ type: 'Pari parieur Covers',",
     "  const GAMES = games, STARTED = started, UNIT = 'points';\n  const LEGP = (g: any, l: any) => l ? pFor(g, l.kind, l.team ?? null, l.line ?? null) : null;\n" + SECTION +
     """  for (const c of olbgTop) preds.push({ type: 'Consensus OLBG', game_id: c.game_id, selection: `${c.label} (${c.n}/${c.total} tipsters)`, prob: c.notre ?? 0.5, cote: c.cote, legs: [{ kind: c.leg.kind, team: c.leg.team, line: c.leg.line, game_id: c.game_id }] });
  for (const m of olbgMatchs) if (!m.commence && m.best) preds.push({ type: 'Pari tipster OLBG', parieur: m.best.tipster, game_id: m.game_id, selection: `${m.best.tipster} : ${m.best.label}`, prob: m.best.notre ?? 0.5, cote: m.best.cote, legs: [{ kind: m.best.leg.kind, team: m.best.leg.team, line: m.best.leg.line, game_id: m.game_id }] });
  for (const a of autres) preds.push({ type: 'Pari parieur Covers',"""),
    ("top5: { parieurs: top5,", "olbg, top5: { parieurs: top5,"),
    ("['top5', 'Pari top Covers'],", "['top5', 'Pari top Covers'], ['olbg_top', 'Consensus OLBG'], ['olbg_best', 'Pari tipster OLBG'],"),
    ("'Pari parieur Covers', 'Pari top Covers',", "'Pari parieur Covers', 'Pari top Covers', 'Consensus OLBG', 'Pari tipster OLBG',"),
])

# ---------------------------------------------------------------- pages
BLOCK = r"""    <h2>Top paris OLBG</h2>${bil(S.bilan?.olbg_top)}
    <p class="lead">OLBG.com est une communauté britannique de pronostiqueurs : la plateforme enregistre leurs résultats sur 12 mois (gains calculés sur une mise de 10 points). Voici les choix où au moins 5 tipsters votent et 70 % ou plus sont d'accord, classés par mes chances. À vérifier : je note chacun de ces paris pour mesurer leur vraie valeur.</p>
    ${(S.olbg?.top||[]).length ? `<div class="picks">${S.olbg.top.map((c,i)=>`<article class="pick"><div class="top"><span class="rank">${i+1}</span><div class="who"><b>${esc(c.label)}</b> <span class="sub">${esc(c.match)} · ${esc(c.market)}</span></div><span class="big">${c.notre!=null?pct(c.notre):'—'}</span></div>
      <div class="chips"><span class="chip">${c.n}/${c.total} tipsters (${pct(c.pct)})</span>${c.notre!=null?(c.notre>=0.5?'<span class="chip good">Je suis d’accord</span>':'<span class="chip bad">Je ne suis pas d’accord</span>'):''}${c.cote?`<span class="chip">Cote ${c.cote}</span>`:''}${c.ev!=null?`<span class="chip ${c.ev>0?'good':'bad'}">Espérance ${c.ev>0?'+':''}${Math.round(c.ev*100)} %</span>`:''}</div>
      <p class="sub" style="margin:0">${esc(c.avis)}</p></article>`).join('')}</div>` : `<div class="empty">${S.olbg?.ok===false?'olbg.com non disponible pour le moment.':'Pas de consensus fort chez les tipsters OLBG ce soir.'}</div>`}
    <h2>Meilleur tipster OLBG de chaque match</h2>${bil(S.bilan?.olbg_best)}
    ${(S.olbg?.matchs||[]).length ? table([
      ['Match', m=>[`<b>${esc(m.match)}</b>${m.commence?' <span class="sub">commencé</span>':''}<br><a class="sub" href="${esc(m.url)}" target="_blank" rel="noopener">voir sur OLBG</a>`, m.match]],
      ['Choix le plus suivi', m=>[m.populaire?`${esc(m.populaire.label)}<br><span class="sub">${m.populaire.n}/${m.populaire.total} tipsters · moi ${pct(m.populaire.notre)}</span>`:'—', m.populaire?.pct??0]],
      ['Meilleur tipster', m=>[m.best?`<b>${esc(m.best.tipster)}</b><br><span class="sub">12 mois : ${m.best.profit>0?'+':''}${m.best.profit} pts, ${m.best.strike??'—'} % gagnés · 30 j : ${m.best.p30??'—'}</span>`:'—', m.best?.profit??-999]],
      ['Son pari', m=>[m.best?esc(m.best.label):'—', m.best?.label||'']],
      ['Mes chances', m=>[m.best?P(m.best.notre,.55,.45):'—', m.best?.notre??-1], 1],
      ['Mon avis', m=>[m.best?esc(m.best.avis):'', 0, 'wrapcell']],
    ], S.olbg.matchs) : ''}
"""
for f in ['public/index.html', 'public/nba.html', 'scripts/nba_page_script.js']:
    patch(f, [("    <h2>2 paris d'autres parieurs</h2>${bil(S.bilan?.autres)}", BLOCK + "    <h2>2 paris d'autres parieurs</h2>${bil(S.bilan?.autres)}")])
print('ok')
