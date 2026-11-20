p = 'netlify/functions/lib/pipeline.mts'
s = open(p, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, old[:70]
    s = s.replace(old, new)


# 1. taux de buts : volume de tirs x réussite ramenée vers la moyenne
rep("""        const g_rate = blendRate(cg, cg ? c.goals / cg : 0, pg, pg ? p.goals / pg : 0, 10, isD ? 0.06 : 0.18);
        const a_rate = blendRate(cg, cg ? c.assists / cg : 0, pg, pg ? p.assists / pg : 0, 10, isD ? 0.24 : 0.27);
        const p_rate = blendRate(cg, cg ? c.points / cg : 0, pg, pg ? p.points / pg : 0, 10, isD ? 0.30 : 0.45);""",
"""        // Buts = volume de tirs (stable, se juge vite) x réussite au tir ramenée vers la moyenne (très bruitée).
        const s_rate = blendRate(cg, cg ? c.shots / cg : 0, pg, pg ? p.shots / pg : 0, 6, isD ? 1.3 : 2.0);
        const shPrior = isD ? 0.045 : 0.105, K = 120;
        const sh_true = ((c?.goals || 0) + (p?.goals || 0) + shPrior * K) / ((c?.shots || 0) + (p?.shots || 0) + K);
        const g_goals = blendRate(cg, cg ? c.goals / cg : 0, pg, pg ? p.goals / pg : 0, 10, isD ? 0.06 : 0.18);
        const g_rate = 0.75 * s_rate * sh_true + 0.25 * g_goals;
        // Passes : encore plus bruitées, régression plus forte.
        const a_rate = blendRate(cg, cg ? c.assists / cg : 0, pg, pg ? p.assists / pg : 0, 20, isD ? 0.24 : 0.27);
        const p_rate = g_rate + a_rate;
        const toi_sec = c?.timeOnIcePerGame || p?.timeOnIcePerGame || 0;""")
rep("toi: fmtSec(c?.timeOnIcePerGame), toi_an: fmtSec(ctx.toi.get(s.id)?.ppTimeOnIcePerGame), g_rate, a_rate, p_rate };",
    "toi: fmtSec(c?.timeOnIcePerGame), toi_an: fmtSec(ctx.toi.get(s.id)?.ppTimeOnIcePerGame), g_rate, a_rate, p_rate, s_rate, sh_true, toi_sec };")
rep("        for (const k of ['g_rate', 'a_rate', 'p_rate']) p[k] = r3(p[k]);",
    "        p.tirs_match_attendus = r3(p.s_rate, 2); p.reussite_attendue = r3(p.sh_true * 100, 1);\n        for (const k of ['g_rate', 'a_rate', 'p_rate', 's_rate', 'sh_true']) p[k] = r3(p[k]);")

# 2. forme récente : volume de tirs récent (signal réel) et lecture de la série (chance ou non)
rep("""  pr.sequence = seq.join(' ; ') || '-';""",
"""  pr.sequence = seq.join(' ; ') || '-';
  const sh10 = l10.reduce((s: number, x: any) => s + (x.shots || 0), 0), g10 = l10.reduce((s: number, x: any) => s + x.goals, 0);
  if (n >= 5 && pr.s_rate != null) {
    const recentShots = sh10 / n;
    const newS = 0.8 * pr.s_rate + 0.2 * recentShots;            // un changement de rôle se voit d'abord dans les tirs
    pr.g_rate = Math.max(0, pr.g_rate + 0.75 * (newS - pr.s_rate) * pr.sh_true);
    pr.p_rate = pr.g_rate + pr.a_rate;
    pr.s_rate = newS;
    const xg10 = sh10 * pr.sh_true;
    pr.l10_tirs_match = r3(recentShots, 2);
    pr.chance = r3(g10 - xg10, 2);                                 // buts réels - buts attendus sur 10 matchs
    if (g10 - xg10 >= 1.8 && sh10 > 0) pr.lecture = `Série flatteuse : ${g10} buts sur ${sh10} tirs en ${n} matchs (${Math.round(100 * g10 / sh10)} % de réussite, habituellement ${(pr.sh_true * 100).toFixed(0)} %). Cette réussite ne dure pas : le modèle ne la prolonge pas.`;
    else if (xg10 - g10 >= 1.5 && recentShots >= 2.5) pr.lecture = `Malchanceux : ${sh10} tirs en ${n} matchs pour ${g10} but(s), alors que sa réussite habituelle (${(pr.sh_true * 100).toFixed(0)} %) en donnerait environ ${xg10.toFixed(1)}. Le volume de tirs est là : le modèle s'attend à un retour à la normale.`;
    else pr.lecture = `Production cohérente avec son volume de tirs (${g10} buts pour ${xg10.toFixed(1)} attendus sur ${n} matchs).`;
  }""")

# 3. évaluation des sélections
rep("""    if (p.type === 'Vainqueur') {
      p.resultat = (a.score > h.score ? a.abbrev : h.abbrev) === p.selection_abbr ? 1 : 0;""",
"""    if (p.type === 'Sélection équipe') {
      p.resultat = (a.score > h.score ? a.abbrev : h.abbrev) === p.selection_abbr ? 1 : 0;
    } else if (p.type === 'Vainqueur') {
      p.resultat = (a.score > h.score ? a.abbrev : h.abbrev) === p.selection_abbr ? 1 : 0;""")
rep("p.resultat = !st ? 'N/J' : (p.type === 'But joueur' ? +(st.goals > 0) : p.type === 'Passe joueur' ? +(st.assists > 0) : +(st.points > 0));",
    "p.resultat = !st ? 'N/J' : (/but/i.test(p.type) ? +(st.goals > 0) : /passe/i.test(p.type) ? +(st.assists > 0) : +(st.points > 0));")
rep("return ['Vainqueur', 'But joueur', 'Passe joueur', 'Point joueur'].map(typ => {",
    "return ['Vainqueur', 'But joueur', 'Passe joueur', 'Point joueur', 'Sélection équipe', 'Sélection but', 'Sélection point'].map(typ => {")

# 4. sélection du soir
rep("""  // remplace les prédictions non évaluées des matchs pas encore commencés""",
"""  const selection = buildSelection(outGames, outPlayers, startedIds);
  const sbase = (gid: number) => { const g = outGames.find(x => x.game_id === gid); return { date: today, etape: MODE_LABEL[mode as 'update'], game_id: gid, match: `${g.exterieur} @ ${g.domicile}`, domicile: g.domicile, exterieur: g.exterieur, confiance: g.confiance, resultat: null, consulte: ctx.consulted, cote: null, prob_implicite: null, valeur: null }; };
  for (const t of selection.equipes) newPreds.push({ ...sbase(t.game_id), type: 'Sélection équipe', selection: t.equipe, selection_abbr: t.equipe, prob: t.prob, cote: t.cote, prob_implicite: t.imp });
  for (const [list, typ] of [[selection.buts, 'Sélection but'], [selection.points, 'Sélection point']] as const) for (const p of list) newPreds.push({ ...sbase(p.game_id), type: typ, selection: p.nom, player_id: p.id, pos: p.pos, ligne: p.ligne, prob: p.prob });
  // remplace les prédictions non évaluées des matchs pas encore commencés""")
rep("  return { games: outGames, players: outPlayers, injuries, lineupInfo, oddsInfo };\n}",
"""  return { games: outGames, players: outPlayers, injuries, lineupInfo, oddsInfo, selection };
}

// ------------------------------------------------------------------ sélection du soir (5 joueurs point, 5 buteurs, équipes)
function buildSelection(games: any[], players: any[], started: Set<number>) {
  const gById = new Map(games.map(g => [g.game_id, g]));
  const confW: Record<string, number> = { 'Élevée': 30, 'Moyenne': 20, 'Faible': 10 };
  const eligible = players.filter(p => {
    const g = gById.get(p.game_id);
    if (!g || started.has(p.game_id)) return false;
    if (/absent|incertain/i.test(p.statut)) return false;
    if ((p.mj || 0) + (p.prev_mj || 0) < 25) return false;                          // trop peu de matchs pour juger
    if (p.toi_sec && p.toi_sec < (p.pos === 'D' ? 18 * 60 : 14 * 60)) return false;  // rôle trop limité
    return true;
  }).map(p => {
    const g = gById.get(p.game_id);
    const opp = p.equipe === g.domicile ? g.exterieur : g.domicile;
    const lineTop = /^(L1|L2|P1)$/.test(p.ligne);
    const fiab = Math.round(Math.min(1, ((p.mj || 0) + (p.prev_mj || 0)) / 70) * 35 + (lineTop ? 25 : p.ligne !== 'non disponible' ? 12 : 0)
      + (g.gardiens?.[opp]?.stats ? 10 : 0) + (confW[g.confiance] || 10));
    return { ...p, fiabilite: fiab, opp };
  }).filter(p => p.fiabilite >= 50);

  const pickTop = (key: 'p_point' | 'p_but') => {
    const out: any[] = []; const perTeam: Record<string, number> = {}; const perGame: Record<number, number> = {};
    for (const p of [...eligible].sort((a, b) => b[key] - a[key] || b.fiabilite - a.fiabilite)) {
      if ((perTeam[p.equipe] || 0) >= 2 || (perGame[p.game_id] || 0) >= 3) continue;   // diversifier : un match fermé ne doit pas tout faire tomber
      perTeam[p.equipe] = (perTeam[p.equipe] || 0) + 1; perGame[p.game_id] = (perGame[p.game_id] || 0) + 1;
      out.push(p); if (out.length === 5) break;
    }
    return out.map(p => {
      const g = gById.get(p.game_id);
      const xg = p.equipe === g.domicile ? g.buts_attendus_dom : g.buts_attendus_ext;
      const gk = g.gardiens?.[p.opp];
      const why = [
        `${p.tirs_match_attendus ?? '?'} tirs attendus par match, réussite au tir de référence ${p.reussite_attendue ?? '?'} % (saison + précédente, ramenée vers la moyenne).`,
        `${p.toi || '?'} de temps de glace${p.toi_an ? `, dont ${p.toi_an} en avantage numérique` : ''}${p.ligne !== 'non disponible' ? `, ${p.ligne} selon nhl.com` : ''}.`,
        `${p.equipe} attend ${xg} buts ce soir contre ${p.opp}${gk?.stats ? ` (gardien ${gk.nom}, ${gk.stats.pct_arrets ?? gk.stats.prev_pct_arrets ?? 'n.d.'} d'arrêts)` : ''}.`,
      ];
      if (p.lecture) why.push(p.lecture);
      return { id: p.id, nom: p.nom, equipe: p.equipe, opp: p.opp, pos: p.pos, ligne: p.ligne, game_id: p.game_id, match: p.match, prob: p[key], p_but: p.p_but, p_point: p.p_point, fiabilite: p.fiabilite, chance: p.chance ?? null, raisons: why };
    });
  };

  const equipes = games.filter(g => !started.has(g.game_id)).map(g => {
    const home = g.p_dom >= g.p_ext, team = home ? g.domicile : g.exterieur, opp = home ? g.exterieur : g.domicile;
    const prob = home ? g.p_dom : g.p_ext, mk = g.p_marche_dom == null ? null : (home ? g.p_marche_dom : 1 - g.p_marche_dom);
    const mod = g.p_modele_dom == null ? null : (home ? g.p_modele_dom : 1 - g.p_modele_dom);
    const score = prob * 100 + (mk != null && Math.abs(mod - mk) <= 0.05 ? 5 : 0) - (g.b2b.includes(team) ? 5 : 0) - (g.confiance === 'Faible' ? 8 : 0) - (!g.gardiens?.[team]?.stats ? 5 : 0);
    const notes: string[] = [];
    notes.push(`Probabilité retenue ${Math.round(prob * 100)} % (${home ? 'à domicile' : 'à l’extérieur'}), ${g.buts_attendus_dom}–${g.buts_attendus_ext} buts attendus (domicile–extérieur).`);
    if (mk != null) notes.push(Math.abs(mod - mk) <= 0.05 ? `Le marché est d'accord (${Math.round(mk * 100)} %) : signal plus solide.` : `Désaccord avec le marché (modèle seul ${Math.round(mod * 100)} %, marché ${Math.round(mk * 100)} %) : prudence.`);
    if (g.b2b.includes(team)) notes.push(`${team} joue son 2e match en 2 soirs.`);
    if (g.b2b.includes(opp)) notes.push(`${opp} joue son 2e match en 2 soirs (avantage ${team}).`);
    notes.push(g.gardiens?.[team]?.stats ? `Gardien ${team} : ${g.gardiens[team].nom} (${g.gardiens[team].statut}).` : `Gardien ${team} non connu : moins fiable.`);
    return { game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, equipe: team, adversaire: opp, prob, cote: home ? g.cote_dom : g.cote_ext, imp: home ? g.imp_dom : g.imp_ext, confiance: g.confiance, score, raisons: notes, solide: prob >= 0.6 && g.confiance !== 'Faible' };
  }).sort((a, b) => b.score - a.score).slice(0, 3);

  return { points: pickTop('p_point'), buts: pickTop('p_but'), equipes };
}""")
rep("      games: evening.games, players: evening.players,", "      selection: evening.selection, games: evening.games, players: evening.players,")
open(p, 'w', encoding='utf-8').write(s)
print('ok')
