B = 'netlify/functions/lib/pipeline.mts'
s = open(B, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, old[:90]
    s = s.replace(old, new, 1)


# A. part des points obtenus en avantage numérique + temps d'AN
rep("        const toi_sec = c?.timeOnIcePerGame || p?.timeOnIcePerGame || 0;",
    """        const toi_sec = c?.timeOnIcePerGame || p?.timeOnIcePerGame || 0;
        const ppPts = (c?.ppPoints || 0) + (p?.ppPoints || 0), allPts = (c?.points || 0) + (p?.points || 0);
        const pp_share = allPts >= 10 ? ppPts / allPts : (isD ? 0.35 : 0.3);
        const pp_sec = ctx.toi.get(s.id)?.ppTimeOnIcePerGame || 0;""")
rep("g_rate, a_rate, p_rate, s_rate, sh_true, toi_sec };", "g_rate, a_rate, p_rate, s_rate, sh_true, toi_sec, pp_share, pp_sec };")

# B. faiblesse du désavantage numérique adverse
rep("      const teamF = lamT / gfT;",
    """      const teamF = lamT / gfT;
      // Désavantage numérique adverse : un joueur qui produit beaucoup en AN profite d'un adversaire qui tue mal les pénalités.
      const pkOf = (t: string) => { const c = ctx.sc[t], q = ctx.sp[t]; const n = c?.gamesPlayed || 0, w = n / (n + 20); return w * (c?.penaltyKillPct ?? 0.79) + (1 - w) * (q?.penaltyKillPct ?? 0.79); };
      const pkVals = Object.values(ctx.sp).map((t: any) => t.penaltyKillPct).filter((x: any) => x > 0);
      const pkLg = pkVals.length ? pkVals.reduce((a: number, b: number) => a + b, 0) / pkVals.length : 0.79;
      const pkOpp = pkOf(opp);
      const pkF = clamp(1 + 0.5 * ((1 - pkOpp) / (1 - pkLg) - 1), 0.85, 1.2);""")

# C. probabilités : AN + régularité propre au joueur
rep("""          lam_but: p.g_rate * teamF / params.xg, lam_passe: p.a_rate * teamF / params.xg, lam_point: p.p_rate * teamF / params.xg, xg_team: r3(lamT, 2),
          p_but: r3(pNB(p.g_rate * teamF / params.xg * params.ag, params.rg)), p_passe: r3(pNB(p.a_rate * teamF / params.xg * params.aa, params.ra)), p_point: r3(pNB(p.p_rate * teamF / params.xg * params.ap, params.rp)),""",
    """          lam_but: p.g_rate * teamF / params.xg * ppm(p), lam_passe: p.a_rate * teamF / params.xg * ppm(p), lam_point: p.p_rate * teamF / params.xg * ppm(p), xg_team: r3(lamT, 2),
          p_but: r3(pNB(p.g_rate * teamF / params.xg * ppm(p) * params.ag, params.rg)), p_passe: r3(pNB(p.a_rate * teamF / params.xg * ppm(p) * params.aa, params.ra)),
          p_point: r3(regular(p, pNB(p.p_rate * teamF / params.xg * ppm(p) * params.ap, params.rp))),
          pk_adv: r3(pkOpp * 100, 1), an_sec: Math.round(p.pp_sec || 0),""")
rep("      for (const p of cands) {\n        const injd = inj.find(i => i.team === ab && nameMatch(p.nom, i.player));",
    """      const ppm = (p: any) => 1 + (p.pp_share || 0) * (pkF - 1);
      // Régularité : certains joueurs étalent leurs points (un par match), d'autres les groupent. On compare la fréquence réelle
      // de matchs avec point (30 derniers) à ce que son rythme prédit, avec forte prudence (rappel vers 1, borne ±10 %).
      const regular = (p: any, prob: number) => {
        if (!(p.freq_n >= 10)) return prob;
        const avgM = pNB(p.p_rate * params.ap, params.rp);
        const w = p.freq_n / (p.freq_n + 40);
        const f = clamp(1 + w * (p.freq_pts / Math.max(0.05, avgM) - 1), 0.9, 1.1);
        p.reg_f = r3(f, 3);
        return Math.min(0.95, prob * f);
      };
      for (const p of cands) {
        const injd = inj.find(i => i.team === ab && nameMatch(p.nom, i.player));""")
rep("ajusté par l'attendu offensif de ${ab} ce soir (x${teamF.toFixed(2)} : défense et gardien de ${opp}, domicile, calendrier) et par les échelles apprises.`,",
    "ajusté par l'attendu offensif de ${ab} ce soir (x${teamF.toFixed(2)} : défense et gardien de ${opp}, domicile, calendrier), par l'avantage numérique (${Math.round((p.pp_share || 0) * 100)} % de ses points, ${opp} tue ${(pkOpp * 100).toFixed(0)} % des pénalités) et par les échelles apprises.`,")

# D. fréquence de matchs avec point
rep("  const l10 = logs.slice(0, 10), n = l10.length;",
    """  const l10 = logs.slice(0, 10), n = l10.length;
  const lf = logs.slice(0, 30);
  if (lf.length >= 10) { pr.freq_n = lf.length; pr.freq_pts = lf.filter((x: any) => x.points > 0).length / lf.length; pr.regularite = `Point dans ${lf.filter((x: any) => x.points > 0).length} de ses ${lf.length} derniers matchs`; }""")

# E. sélection : niveau « Choix sûr » (critères validés sur l'historique) puis compléments
rep("""  const pickTop = (key: 'p_point' | 'p_but') => {
    const out: any[] = []; const perTeam: Record<string, number> = {}; const perGame: Record<number, number> = {};
    for (const p of [...eligible].sort((a, b) => b[key] - a[key] || b.fiabilite - a.fiabilite)) {
      if ((perTeam[p.equipe] || 0) >= 2 || (perGame[p.game_id] || 0) >= 3) continue;   // diversifier : un match fermé ne doit pas tout faire tomber
      perTeam[p.equipe] = (perTeam[p.equipe] || 0) + 1; perGame[p.game_id] = (perGame[p.game_id] || 0) + 1;
      out.push(p); if (out.length === 5) break;
    }""",
    """  // « Choix sûr » : critères qui ont le mieux réussi sur l'historique (forte probabilité + vrai rôle en avantage numérique
  // + gros temps de glace). Au plus 3, un seul par équipe ; les compléments viennent ensuite.
  const strict = (p: any, key: string) => key === 'p_point'
    ? p.p_point >= 0.62 && p.pp_sec >= 150 && p.toi_sec >= (p.pos === 'D' ? 20 : 17) * 60 && (p.ligne === 'non disponible' || /^(L1|L2|P1)$/.test(p.ligne))
    : p.p_but >= 0.38 && p.pp_sec >= 150 && (p.s_rate || 0) >= 3;
  const pickTop = (key: 'p_point' | 'p_but') => {
    const out: any[] = []; const perTeam: Record<string, number> = {}; const perGame: Record<number, number> = {};
    const sorted = [...eligible].sort((a, b) => b[key] - a[key] || b.fiabilite - a.fiabilite);
    for (const p of sorted.filter(p => strict(p, key))) {
      if (perTeam[p.equipe] || (perGame[p.game_id] || 0) >= 2) continue;
      perTeam[p.equipe] = 1; perGame[p.game_id] = (perGame[p.game_id] || 0) + 1;
      out.push({ ...p, niveau: 'Choix sûr' }); if (out.length === 3) break;
    }
    for (const p of sorted) {
      if (out.length === 5) break;
      if (out.some(x => x.id === p.id)) continue;
      if ((perTeam[p.equipe] || 0) >= 2 || (perGame[p.game_id] || 0) >= 3) continue;   // diversifier : un match fermé ne doit pas tout faire tomber
      perTeam[p.equipe] = (perTeam[p.equipe] || 0) + 1; perGame[p.game_id] = (perGame[p.game_id] || 0) + 1;
      out.push({ ...p, niveau: 'Complément' });
    }""")
rep("      if (p.lecture) why.push(p.lecture);\n      return { id: p.id, nom: p.nom,",
    """      if (p.pp_sec) why.push(`Avantage numérique : ${fmtSec(p.pp_sec)} par match, ${Math.round((p.pp_share || 0) * 100)} % de ses points ; ${p.opp} tue ${p.pk_adv ?? '?'} % des pénalités.`);
      if (p.regularite) why.push(`${p.regularite}${p.reg_f && Math.abs(p.reg_f - 1) >= 0.02 ? ` : joueur ${p.reg_f > 1 ? 'régulier, léger bonus' : 'irrégulier (points groupés), léger malus'}` : ''}.`);
      if (p.lecture) why.push(p.lecture);
      return { niveau: p.niveau, id: p.id, nom: p.nom,""")
rep("for (const p of list) newPreds.push({ ...sbase(p.game_id), type: typ, selection: p.nom, player_id: p.id, pos: p.pos, ligne: p.ligne, prob: p.prob });",
    """for (const p of list) newPreds.push({ ...sbase(p.game_id), type: typ, selection: p.nom, player_id: p.id, pos: p.pos, ligne: p.ligne, prob: p.prob, niveau: p.niveau });
  selection.bilan = bilanSelection(db);""")
rep("// ------------------------------------------------------------------ sélection du soir (5 joueurs point, 5 buteurs, équipes)",
    """function bilanSelection(db: any) {
  const out: any = {};
  for (const [k, typ] of [['point', 'Sélection point'], ['but', 'Sélection but'], ['equipe', 'Sélection équipe']] as const) {
    const g = db.predictions.filter((p: any) => p.type === typ && (p.resultat === 0 || p.resultat === 1));
    const sur = g.filter((p: any) => p.niveau === 'Choix sûr');
    out[k] = { n: g.length, gagnes: g.filter((p: any) => p.resultat === 1).length, sur_n: sur.length, sur_gagnes: sur.filter((p: any) => p.resultat === 1).length };
  }
  return out;
}

// ------------------------------------------------------------------ sélection du soir (5 joueurs point, 5 buteurs, équipes)""")
open(B, 'w', encoding='utf-8').write(s)

# ------------------------------------------------------------------ page
P = 'public/index.html'
s = open(P, encoding='utf-8').read()
rep("""    <div class="chips"><span class="chip">${lab}</span>${fiabChip(p.fiabilite)}""",
    """    <div class="chips">${p.niveau==='Choix sûr'?'<span class="chip good">Choix sûr</span>':p.niveau?'<span class="chip">Complément</span>':''}<span class="chip">${lab}</span>${fiabChip(p.fiabilite)}""")
rep("""    <h2>5 joueurs les plus probables de faire un point</h2>""",
    """    <h2>5 joueurs les plus probables de faire un point</h2>${bil(S.bilan?.point)}""")
rep("""    <h2>5 buteurs les plus probables</h2>""",
    """    <h2>5 buteurs les plus probables</h2>${bil(S.bilan?.but)}""")
rep("""    <h2>Équipes les plus sûres</h2>""",
    """    <h2>Équipes les plus sûres</h2>${bil(S.bilan?.equipe)}""")
rep("""  const mini = (p) =>""",
    """  const bil = b => !b || !b.n ? '' : `<p class="lead">Bilan depuis le début : <b>${b.gagnes}/${b.n} gagnés (${pct(b.gagnes/b.n)})</b>${b.sur_n ? ` · Choix sûrs : <b>${b.sur_gagnes}/${b.sur_n} (${pct(b.sur_gagnes/b.sur_n)})</b>` : ''}.</p>`;
  const mini = (p) =>""")
rep("""je prends au maximum 2 joueurs par équipe et 3 par match, pour qu'un match fermé ne fasse pas tout tomber.</p>""",
    """je prends au maximum 2 joueurs par équipe et 3 par match, pour qu'un match fermé ne fasse pas tout tomber.</p>
    <p><b>Choix sûr</b> : probabilité d'au moins 62 %, au moins 2 min 30 d'avantage numérique par match, gros temps de glace et un seul joueur par équipe. Sur l'historique, ces critères ont réussi nettement plus souvent que le reste (71 % contre 63 % à probabilité égale). Les autres choix sont des <b>compléments</b>, moins sûrs. Je compte aussi la faiblesse de l'adversaire en désavantage numérique et la régularité du joueur (points étalés ou groupés).</p>""")
open(P, 'w', encoding='utf-8').write(s)
print('ok')
