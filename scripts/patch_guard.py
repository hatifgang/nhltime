B = 'netlify/functions/lib/'


def patch(path, pairs):
    s = open(B + path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (path, old[:80])
        s = s.replace(old, new, 1)
    open(B + path, 'w', encoding='utf-8').write(s)


patch('learn.mts', [
    ("""  return best;
}
/** Échelle des buts attendus""",
     """  const dataNll = (a: number, r: number) => rows.reduce((s, x) => s + ll(pNB(x.lam * a, r), x.y), 0);
  return { ...best, gain: dataNll(A.v, R.v) - dataNll(best.a, best.r) };
}
/** Échelle des buts attendus"""),
    ("""  for (let i = 0; i < 40; i++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (obj(m1) < obj(m2)) hi = m2; else lo = m1; }
  return (lo + hi) / 2;
}

function segment""",
     """  for (let i = 0; i < 40; i++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (obj(m1) < obj(m2)) hi = m2; else lo = m1; }
  const s = (lo + hi) / 2;
  const nll = (k: number) => rows.reduce((t, r) => t + k * r.xg - r.y * Math.log(k * r.xg), 0);
  return { s, gain: nll(P.v) - nll(s) };
}

// Garde-fou : un réglage ne quitte sa valeur de départ que si les résultats le prouvent
// (test du rapport de vraisemblance, seuil 5 % : 1,92 pour 1 réglage, 3,0 pour 2, 7,0 pour 7).
const LR = { 1: 1.92, 2: 3.0, 7: 7.0 } as const;

function segment"""),
    ("""    const fitted = fitTeam(rows, prevParams);
    for (const k of TEAM_KEYS) {
      const before = prevParams[k], after = r3(fitted[k], 3)!;""",
     """    const fitted = fitTeam(rows, prevParams);
    const base: Params = { ...prevParams }; for (const k of TEAM_KEYS) base[k] = PRIORS[k].v;
    const nll = (p: Params) => rows.reduce((s, r) => s + ll(gameProbs(r.f, p).final_h, r.y), 0);
    const gain = nll(base) - nll(fitted);
    const proven = gain >= LR[7];
    if (!proven) lessons.push(`Réglages d'équipe : les ${rows.length} matchs évalués ne prouvent pas encore qu'il faut changer (gain ${gain.toFixed(2)} < ${LR[7]}). Je garde les réglages de départ.`);
    for (const k of TEAM_KEYS) {
      const before = prevParams[k], after = r3(proven ? fitted[k] : PRIORS[k].v, 3)!;"""),
    ("""      const a = r3(fit.a, 3)!, r = r3(fit.r, 2)!;""",
     """      const proven = fit.gain >= LR[2];
      const a = r3(proven ? fit.a : PRIORS[key].v, 3)!, r = r3(proven ? fit.r : PRIORS[rk].v, 2)!;
      if (!proven) lessons.push(`${typ} : sur ${pr.length} paris évalués, l'écart entre prévu et réel reste dans le bruit (gain ${fit.gain.toFixed(2)} < ${LR[2]}). Calcul inchangé.`);"""),
    ("""    const s = r3(fitXg(tm.map((t: any) => ({ xg: t.xg / (t.xg_scale || 1), y: t.buts }))), 3)!;""",
     """    const fx = fitXg(tm.map((t: any) => ({ xg: t.xg / (t.xg_scale || 1), y: t.buts })));
    const s = r3(fx.gain >= LR[1] ? fx.s : PRIORS.xg.v, 3)!;
    if (fx.gain < LR[1]) lessons.push(`Buts attendus des équipes : sur ${tm.length} scores, l'écart avec la réalité n'est pas significatif (gain ${fx.gain.toFixed(2)} < ${LR[1]}).`);"""),
])

# Pipeline : la part « joueur » n'inclut pas l'échelle des buts d'équipe (sinon double comptage avec ap/ag/aa).
patch('pipeline.mts', [
    ("""          lam_but: p.g_rate * teamF, lam_passe: p.a_rate * teamF, lam_point: p.p_rate * teamF, xg_team: r3(lamT, 2),
          p_but: r3(pNB(p.g_rate * teamF * params.ag, params.rg)), p_passe: r3(pNB(p.a_rate * teamF * params.aa, params.ra)), p_point: r3(pNB(p.p_rate * teamF * params.ap, params.rp)),""",
     """          lam_but: p.g_rate * teamF / params.xg, lam_passe: p.a_rate * teamF / params.xg, lam_point: p.p_rate * teamF / params.xg, xg_team: r3(lamT, 2),
          p_but: r3(pNB(p.g_rate * teamF / params.xg * params.ag, params.rg)), p_passe: r3(pNB(p.a_rate * teamF / params.xg * params.aa, params.ra)), p_point: r3(pNB(p.p_rate * teamF / params.xg * params.ap, params.rp)),"""),
])
print('ok')
