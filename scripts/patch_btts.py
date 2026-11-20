B = 'netlify/functions/lib/'


def patch(path, pairs):
    s = open(B + path, encoding='utf-8').read()
    for o, n in pairs:
        assert o in s, (path, o[:80])
        s = s.replace(o, n, 1)
    open(B + path, 'w', encoding='utf-8').write(s)


patch('pipeline.mts', [
    ("import { gameProbs, defaultParams,", "import { gameProbs, bttsProbs, defaultParams,"),
    # ---- notation : buts par période depuis le score nhl.com
    ("  let newly = 0;\n  for (const p of pending) {\n    const box = boxes.get(p.game_id);\n    if (!box || !FINAL.includes(box.gameState)) continue;\n    const a = box.awayTeam, h = box.homeTeam;\n",
     """  // « Les deux marquent » : buts par période (temps réglementaire) lus dans le score nhl.com du jour du match
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
"""),
    # ---- prédictions du soir
    ("  for (const { game, players, inj, feat, mlA, mlH, x3 } of perGame) {\n    outGames.push(game); outPlayers.push(...players); injuries.push(...inj);\n    if (startedIds.has(game.game_id)) continue;\n",
     """  for (const { game, players, inj, feat, mlA, mlH, x3 } of perGame) {
    outGames.push(game); outPlayers.push(...players); injuries.push(...inj);
    const bt = bttsProbs(game.buts_attendus_dom, game.buts_attendus_ext, (params as any).btts);
    game.btts = { p: bt.map(x => r3(x.p)), dom: bt.map(x => r3(x.dom)), ext: bt.map(x => r3(x.ext)) };
    if (startedIds.has(game.game_id)) continue;
"""),
    ("  const selection = buildSelection(outGames, outPlayers, startedIds, signalBilan(db));\n",
     """  const selection = buildSelection(outGames, outPlayers, startedIds, signalBilan(db));
  selection.btts = bttsSelection(outGames, startedIds, db);
"""),
    ("  selection.bilan = bilanSelection(db);\n",
     """  for (const g of outGames) if (!startedIds.has(g.game_id) && g.btts) newPreds.push({ ...sbase(g.game_id), v: 2, type: 'Deux marquent', selection: 'Les deux équipes marquent (60 min)', prob: g.btts.p[0], segs: g.btts.p, xg_dom: g.buts_attendus_dom, xg_ext: g.buts_attendus_ext });
  if (selection.btts.match) { const m = selection.btts.match; newPreds.push({ ...sbase(m.game_id), v: 2, type: 'Deux marquent : match le plus sûr', selection: `${m.match} : les deux marquent (60 min)`, prob: m.prob, periode: 0 }); }
  if (selection.btts.periode) { const m = selection.btts.periode; newPreds.push({ ...sbase(m.game_id), v: 2, type: 'Deux marquent : période la plus sûre', selection: `${m.match} : les deux marquent en ${m.label}`, prob: m.prob, periode: m.k }); }
  selection.bilan = bilanSelection(db);
"""),
    ("['buteur', 'Buteur du soir'], ['safe', 'Pari safe du jour']] as const) {",
     "['buteur', 'Buteur du soir'], ['safe', 'Pari safe du jour'], ['btts_match', 'Deux marquent : match'], ['btts_periode', 'Deux marquent : période']] as const) {"),
    ("// ------------------------------------------------------------------ sélection du soir (5 joueurs point, 5 buteurs, équipes)",
     """// ------------------------------------------------------------------ « Les deux équipes marquent »
const PER_LAB = ['match entier', '1re période', '2e période', '3e période'];
function bttsSelection(games: any[], started: Set<number>, db: any) {
  const liste = games.filter(g => g.btts).map(g => {
    const k = [1, 2, 3].sort((x, y) => g.btts.p[y] - g.btts.p[x])[0];
    return { game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, ext: g.exterieur, dom: g.domicile, heure: g.heure_paris ?? g.heure ?? null, commence: started.has(g.game_id),
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

// ------------------------------------------------------------------ sélection du soir (5 joueurs point, 5 buteurs, équipes)"""),
])

# ---- apprentissage : parts des périodes et recalage logit, a posteriori autour des valeurs de départ
patch('learn.mts', [
    ("  return { params, entry: { date: today, changes, lessons, metrics, segments: segs, calib } };",
     """  // 8. « Les deux équipes marquent » : parts des buts par période et recalage, appris sur les vrais scores
  {
    const seen = new Set<number>();
    const bt = graded.filter((p: any) => p.type === 'Deux marquent' && Array.isArray(p.res_seg) && p.xg_dom != null).reverse().filter((p: any) => !seen.has(p.game_id) && seen.add(p.game_id)).slice(0, 1500);
    if (bt.length >= 40) {
      const D = BTTS_DEFAULT, prev = (params as any).btts || D;
      const goals = [1, 2, 3].map(k => bt.reduce((s: number, p: any) => s + p.buts_seg[k][0] + p.buts_seg[k][1], 0));
      const T = goals.reduce((s, x) => s + x, 0), W0 = 3000;   // la saison passée pèse comme 3000 buts
      const s = [1, ...[1, 2, 3].map(k => r3((goals[k - 1] + W0 * D.s[k]) / (T + W0), 3)!)];
      const P1 = (l: number) => 1 - Math.exp(-l);
      const a: number[] = [], b: number[] = [];
      for (const k of [0, 1, 2, 3]) {
        const xs = bt.map((p: any) => ({ x: logit(Math.min(0.99, Math.max(0.01, P1(p.xg_dom * s[k]) * P1(p.xg_ext * s[k])))), y: p.res_seg[k] }));
        let best = { a: D.a[k], b: D.b[k], v: Infinity };
        for (let ai = -1; ai <= 1.5; ai += 0.02) for (let bi = 0.3; bi <= 2; bi += 0.05) {
          let v = (ai - D.a[k]) ** 2 / (2 * 0.25 ** 2) + (bi - D.b[k]) ** 2 / (2 * 0.2 ** 2);
          for (const { x, y } of xs) { const q = sigmoid(ai + bi * x); v -= y ? Math.log(q) : Math.log(1 - q); }
          if (v < best.v) best = { a: ai, b: bi, v };
        }
        a.push(r3(best.a, 2)!); b.push(r3(best.b, 2)!);
      }
      (params as any).btts = { s, a, b, n: bt.length };
      const rate = (k: number) => Math.round(bt.reduce((t: number, p: any) => t + p.res_seg[k], 0) / bt.length * 100);
      lessons.push(`Les deux équipes marquent (${bt.length} matchs notés) : match entier ${rate(0)} %, 1re période ${rate(1)} %, 2e ${rate(2)} %, 3e ${rate(3)} %. Recalage mis à jour (base : ${JSON.stringify(prev.a)} → ${JSON.stringify(a)}).`);
    }
  }

  return { params, entry: { date: today, changes, lessons, metrics, segments: segs, calib } };"""),
])
s = open(B + 'learn.mts', encoding='utf-8').read()
print([l for l in s.splitlines() if l.startswith('import')])
