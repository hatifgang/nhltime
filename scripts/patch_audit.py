B = 'netlify/functions/lib/'


def patch(path, pairs):
    s = open(B + path, encoding='utf-8').read()
    for o, n in pairs:
        assert o in s, (path, o[:80])
        s = s.replace(o, n, 1)
    open(B + path, 'w', encoding='utf-8').write(s)


# ---------------- nouveaux réglages : échelles propres aux défenseurs
patch('model.mts', [
    ("  wi: number;     // poids du modèle « part des buts sur la glace » dans les points joueurs\n}",
     "  wi: number;     // poids du modèle « part des buts sur la glace » dans les points joueurs\n"
     "  gD: number; aD: number; pD: number; // échelles propres aux défenseurs (buts, passes, points)\n}"),
    ("  wi: { v: 0.5, sd: 0.2, min: 0, max: 1, label: 'Poids du modèle sur la glace (points joueurs)' },",
     "  wi: { v: 0.5, sd: 0.2, min: 0, max: 1, label: 'Poids du modèle sur la glace (points joueurs)' },\n"
     "  gD: { v: 1, sd: 0.15, min: 0.5, max: 1.6, label: 'Échelle buts des défenseurs' },\n"
     "  aD: { v: 1, sd: 0.15, min: 0.5, max: 1.6, label: 'Échelle passes des défenseurs' },\n"
     "  pD: { v: 1, sd: 0.15, min: 0.5, max: 1.6, label: 'Échelle points des défenseurs' },"),
])

# ---------------- apprentissage : un réglage seul = estimation a posteriori (le prior fait office de prudence)
patch('learn.mts', [
    ("const TEAM_KEYS: (keyof Params)[] = ['home', 'form', 'b2b', 'goalie', 'inj', 'h2h'];   // wm a son propre test (1 réglage)",
     "const TEAM_KEYS: (keyof Params)[] = ['form', 'b2b', 'goalie', 'inj', 'h2h'];   // home, wm, wt, xg : estimés seuls (a posteriori)"),
    ("const LR = { 1: 1.92, 2: 3.0, 6: 6.3, 7: 7.0 } as const;", "const LR = { 1: 1.92, 2: 3.0, 5: 5.5, 6: 6.3, 7: 7.0 } as const;"),
    ("    const proven = gain >= LR[6];\n    if (!proven) lessons.push(`Réglages d'équipe : les ${rows.length} matchs évalués ne prouvent pas encore qu'il faut changer (gain ${gain.toFixed(2)} < ${LR[6]}). Je garde les réglages de départ.`);",
     "    const proven = gain >= LR[5];\n    if (!proven) lessons.push(`Forme, fatigue, gardien, absences, confrontations : les ${rows.length} matchs évalués ne prouvent pas encore qu'il faut changer (gain ${gain.toFixed(2)} < ${LR[5]}). Je garde les réglages de départ.`);"),
    ("    const target = r3(gain >= LR[1] ? bw : W.v, 2)!;", "    const target = r3(bw, 2)!;   // estimation a posteriori : bouge en proportion des preuves"),
    ("    if (gain < LR[1]) lessons.push(`Modèle contre marché : sur ${mk.length} matchs, l'écart n'est pas encore prouvé (gain ${gain.toFixed(2)} < ${LR[1]}). Poids du modèle maintenu à ${Math.round(params.wm * 100)} %.`);",
     "    lessons.push(`Modèle contre marché (${mk.length} matchs) : poids de mon modèle ${Math.round(params.wm * 100)} %, celui des cotes ${100 - Math.round(params.wm * 100)} % (estimation a posteriori, gain ${gain.toFixed(2)}).`);"),
    ("    const target = r3(gain >= LR[1] ? bw : P.v, 2)!;\n    if (Math.abs(target - prevParams.wt) >= 0.02)",
     "    const target = r3(bw, 2)!;\n    if (Math.abs(target - prevParams.wt) >= 0.02)"),
    ("    const target = r3(gain >= LR[1] ? bw : P.v, 2)!;\n    if (Math.abs(target - prevParams.wi) >= 0.02)",
     "    const target = r3(bw, 2)!;\n    if (Math.abs(target - prevParams.wi) >= 0.02)"),
    ("    const s = r3(fx.gain >= LR[1] ? fx.s : PRIORS.xg.v, 3)!;\n    if (fx.gain < LR[1]) lessons.push(`Buts attendus des équipes : sur ${tm.length} scores, l'écart avec la réalité n'est pas significatif (gain ${fx.gain.toFixed(2)} < ${LR[1]}).`);",
     "    const s = r3(fx.s, 3)!;"),
    ("  // 1b. Confiance face au marché : testée seule (1 réglage), pour pouvoir admettre vite que les cotes font mieux.",
     """  // 1a. Avantage domicile, estimé seul (a posteriori)
  if (rows.length >= 30) {
    const H = PRIORS.home;
    const nllH = (x: number) => rows.reduce((s, r) => s + ll(gameProbs(r.f, { ...params, home: x }).final_h, r.y), 0) + (x - H.v) ** 2 / (2 * H.sd ** 2);
    let bh = H.v, bv = Infinity;
    for (let x = H.min; x <= H.max + 1e-9; x += 0.005) { const v = nllH(x); if (v < bv) { bv = v; bh = x; } }
    const target = r3(bh, 3)!;
    if (Math.abs(target - prevParams.home) >= 0.003) { changes.push({ param: 'home', label: H.label, avant: prevParams.home, apres: target, n: rows.length }); params.home = target; }
    const hw = rows.filter(r => r.y === 1).length / rows.length;
    lessons.push(`Domicile : les équipes à domicile ont gagné ${Math.round(hw * 100)} % des ${rows.length} matchs. Avantage retenu : ${(params.home * 100).toFixed(1)} %.`);
  }
  // 1c. Défenseurs : leurs buts, passes et points ne suivent pas la même échelle que les attaquants
  for (const [typ, key, base, r] of [['But joueur', 'gD', 'ag', 'rg'], ['Passe joueur', 'aD', 'aa', 'ra'], ['Point joueur', 'pD', 'ap', 'rp']] as const) {
    const dr = graded.filter(p => p.type === typ && p.pos === 'D' && p.lam_base > 0 && (p.v ?? 1) >= 2).slice(-1500);
    if (dr.length < 60) continue;
    const K = PRIORS[key];
    const nllD = (x: number) => dr.reduce((s, p) => s + ll(pNB(p.lam_base * params[base] * x, params[r]), p.resultat), 0) + (x - K.v) ** 2 / (2 * K.sd ** 2);
    let bx = K.v, bv = Infinity;
    for (let x = K.min; x <= K.max + 1e-9; x += 0.01) { const v = nllD(x); if (v < bv) { bv = v; bx = x; } }
    const target = r3(bx, 2)!;
    if (Math.abs(target - prevParams[key]) >= 0.02) { changes.push({ param: key, label: K.label, avant: prevParams[key], apres: target, n: dr.length }); params[key] = target; }
  }

  // 1b. Confiance face au marché : estimée seule (1 réglage), pour pouvoir admettre vite que les cotes font mieux."""),
])
# home doit aussi être traité dans fitTeam : il n'y est plus (TEAM_KEYS) -> rien à faire

# ---------------- pipeline : échelles défenseurs, paris fun plus prudents, seuil cote 2+
patch('pipeline.mts', [
    ("p_but: r3(Math.min(0.6, calibrate(CAL.but, pNB(p.g_rate * teamF / params.xg * ppm(p) * params.ag, params.rg)))), p_passe: r3(pNB(p.a_rate * teamF / params.xg * ppm(p) * params.aa, params.ra)),",
     "p_but: r3(Math.min(0.6, calibrate(CAL.but, pNB(p.g_rate * teamF / params.xg * ppm(p) * params.ag * (p.pos === 'D' ? params.gD : 1), params.rg)))), p_passe: r3(pNB(p.a_rate * teamF / params.xg * ppm(p) * params.aa * (p.pos === 'D' ? params.aD : 1), params.ra)),"),
    ("p_point: r3(Math.min(0.85, calibrate(CAL.point, regular(p, pNB(lamPts(p) * params.ap, params.rp))))),",
     "p_point: r3(Math.min(0.85, calibrate(CAL.point, regular(p, pNB(lamPts(p) * params.ap * (p.pos === 'D' ? params.pD : 1), params.rp))))),"),
    ("  const cote2 = legs.filter(l => l.marche && l.cote >= 2 && l.prob * l.cote - 1 >= 0.03)",
     "  const cote2 = legs.filter(l => l.marche && l.cote >= 2 && l.prob * l.cote - 1 >= 0.05)   // audit : à +3 % le bilan était négatif"),
    ("    const pool = legs.filter(l => l.prob >= 0.2).sort((x, y) => (y.prob * y.cote) - (x.prob * x.cote) || y.prob - x.prob).slice(0, 30);",
     "    // Audit : 1 pari fun gagné sur 27 pour environ 4 attendus. Les jambes « joueur » (cote juste, sans marché) cumulaient\n"
     "    // les erreurs du modèle : on les décote de 5 % et on préfère les jambes cotées par le marché.\n"
     "    const pool = legs.filter(l => l.prob >= 0.25).map(l => l.marche ? l : { ...l, prob: l.prob * 0.95 })\n"
     "      .sort((x, y) => (y.prob * y.cote) - (x.prob * x.cote) || y.prob - x.prob).slice(0, 30);"),
    ("  const fun = [funSearch(5, 4), funSearch(10, 5)].filter(Boolean);", "  const fun = [funSearch(5, 3), funSearch(10, 4)].filter(Boolean);   // moins de jambes = moins de marge et d'erreurs cumulées"),
])
print('ok')
