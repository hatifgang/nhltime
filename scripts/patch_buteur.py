B = 'netlify/functions/lib/pipeline.mts'
s = open(B, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, old[:90]
    s = s.replace(old, new, 1)


rep("  selection.autres = { paris: autres, n_classes: tb.n_classes, seuil_chance: r3(tb.seuil_chance, 2) };",
    """  selection.autres = { paris: autres, n_classes: tb.n_classes, seuil_chance: r3(tb.seuil_chance, 2) };
  selection.buteur = buteurDuSoir(ctx, outGames, outPlayers, startedIds, lu.games, db);
  if (selection.buteur) { const bt = selection.buteur; newPreds.push({ ...sbase(bt.game_id), v: 2, type: 'Buteur du soir', selection: bt.nom, player_id: bt.id, pos: bt.pos, prob: bt.p_but, cote: null }); }""")
rep("'Pari fun 10+', 'Pari parieur Covers'].map(typ => {", "'Pari fun 10+', 'Pari parieur Covers', 'Buteur du soir'].map(typ => {")
rep("['autres', 'Pari parieur Covers']] as const) {", "['autres', 'Pari parieur Covers'], ['buteur', 'Buteur du soir']] as const) {")
rep("function teamSnapshot(ctx: Ctx, ab: string) {",
    """/** Buteur du soir : un seul joueur, le plus probable de marquer après contrôle de tout ce qui peut le faire échouer. */
function buteurDuSoir(ctx: Ctx, games: any[], players: any[], started: Set<number>, lineups: Record<string, GameLineup>, db: any) {
  const gById = new Map(games.map(g => [g.game_id, g]));
  const cands = players.filter(p => {
    const g = gById.get(p.game_id);
    if (!g || started.has(p.game_id) || /absent|incertain/i.test(p.statut)) return false;
    if ((p.mj || 0) + (p.prev_mj || 0) < 40) return false;                 // historique trop court
    if (p.pos === 'D' || (p.toi_sec && p.toi_sec < 16 * 60)) return false; // les buteurs fiables sont des attaquants à gros temps de jeu
    return p.p_but != null;
  }).map(p => {
    const g = gById.get(p.game_id);
    const L = lineups[`${g.exterieur}@${g.domicile}`];
    const known = !!L;
    let score = p.p_but;
    if (!known) score *= 0.95;                         // composition pas encore publiée : petite prudence
    if ((p.chance ?? 0) >= 1.8) score *= 0.95;          // série flatteuse : historiquement un peu moins bien que prévu
    if (g.b2b?.includes(p.equipe)) score *= 0.97;       // 2e match en 2 soirs
    return { p, g, L, score };
  }).sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (!best) return null;
  const { p, g, L } = best;
  const opp = p.equipe === g.domicile ? g.exterieur : g.domicile;
  const home = p.equipe === g.domicile;
  const tl = L ? (home ? L.home : L.away) : null;
  const ligne = tl?.lines.find((l: string) => l.split(' -- ').some(x => nameMatch(p.nom, x)));
  const partenaires = ligne ? ligne.split(' -- ').filter((x: string) => !nameMatch(p.nom, x)) : [];
  const ts = teamSnapshot(ctx, p.equipe), os = teamSnapshot(ctx, opp);
  const gk = g.gardiens?.[opp];
  const xgTeam = home ? g.buts_attendus_dom : g.buts_attendus_ext;
  const lg = ctx.league;
  const risques: string[] = [];
  if (!L) risques.push('Composition nhl.com pas encore publiée : sa place dans l’alignement n’est pas confirmée.');
  if (!gk?.stats) risques.push(`Gardien partant de ${opp} inconnu.`);
  else if ((gk.stats.pct_arrets ?? gk.stats.prev_pct_arrets ?? 0) >= 0.915) risques.push(`${gk.nom} est un très bon gardien (${gk.stats.pct_arrets ?? gk.stats.prev_pct_arrets} d'arrêts).`);
  if ((p.chance ?? 0) >= 1.8) risques.push('Il marque plus que ses tirs ne le justifient ces derniers temps : cette réussite peut retomber.');
  if (g.b2b?.includes(p.equipe)) risques.push(`${p.equipe} joue son 2e match en 2 soirs.`);
  if ((os.pct_dn ?? 0) >= 83) risques.push(`${opp} tue très bien les pénalités (${os.pct_dn} %) : peu de buts en avantage numérique à espérer.`);
  if ((os.bc_match ?? lg) < lg - 0.3) risques.push(`${opp} encaisse peu (${os.bc_match} buts par match).`);
  const atouts: string[] = [];
  if ((p.l10_tirs_match ?? 0) >= 3.5) atouts.push(`Gros volume de tirs : ${p.l10_tirs_match} par match sur ses 10 derniers.`);
  if ((p.pp_sec ?? 0) >= 180) atouts.push(`Pilier de l'avantage numérique (${p.toi_an} par match).`);
  if ((os.bc_match ?? lg) > lg + 0.3) atouts.push(`${opp} encaisse beaucoup (${os.bc_match} buts par match).`);
  if (gk?.stats && (gk.stats.pct_arrets ?? gk.stats.prev_pct_arrets ?? 1) < 0.895) atouts.push(`Gardien adverse en difficulté : ${gk.nom}, ${gk.stats.pct_arrets ?? gk.stats.prev_pct_arrets} d'arrêts.`);
  if ((p.chance ?? 0) <= -1.5) atouts.push('Malchanceux récemment : beaucoup de tirs, peu de buts. Historiquement, ces joueurs ont un peu mieux réussi que prévu.');
  if (xgTeam >= 3.4) atouts.push(`${p.equipe} devrait marquer beaucoup ce soir (${xgTeam} buts attendus).`);
  const hist = (db.predictions || []).filter((x: any) => x.type === 'Buteur du soir' && (x.resultat === 0 || x.resultat === 1));
  return {
    id: p.id, nom: p.nom, equipe: p.equipe, opp, pos: p.pos, game_id: p.game_id, match: p.match, debut: g.debut_paris,
    p_but: p.p_but, p_point: p.p_point, cote_juste: r3(1 / p.p_but, 2),
    joueur: {
      ligne: p.ligne, partenaires, toi: p.toi, toi_recent: p.toi_recent || null, toi_an: p.toi_an,
      buts: `${p.buts} en ${p.mj} matchs cette saison (${p.buts_match ?? '—'} par match)`, saison_prec: p.prev_mj ? `${p.prev_buts_match} but par match sur ${p.prev_mj} matchs la saison dernière` : 'pas de saison précédente',
      tirs: `${p.tirs_match_attendus} tirs attendus par match, ${p.l10_tirs_match ?? '—'} sur les 10 derniers`, reussite: `${p.reussite_attendue} % de réussite au tir de référence`,
      dix_derniers: `${p.l10_buts_match ?? '—'} but par match sur ses 10 derniers`, sequence: p.sequence, lecture: p.lecture, vs_adv: p.vs_adv,
    },
    equipe_info: { nom: ts.nom, bilan: `${ts.v}-${ts.d}-${ts.dp}`, forme: ts.bilan10, bp: ts.bp_match, an: ts.pct_an, xg_ce_soir: xgTeam, total_marche: g.total_marche ?? null },
    adversaire: { nom: os.nom, bilan: `${os.v}-${os.d}-${os.dp}`, forme: os.bilan10, bc: os.bc_match, tirs_contre: os.tirs_contre_match, dn: os.pct_dn,
      gardien: gk?.nom || 'non connu', gardien_statut: gk?.statut || 'non disponible', gardien_sv: gk?.stats?.pct_arrets ?? null, gardien_sv_prec: gk?.stats?.prev_pct_arrets ?? null },
    atouts, risques,
    autres: cands.slice(1, 4).map(c => ({ nom: c.p.nom, equipe: c.p.equipe, p_but: c.p.p_but })),
    verdict: p.p_but >= 0.45 ? 'Meilleure chance de la soirée, au niveau des meilleurs buteurs de la ligue.' : p.p_but >= 0.38 ? 'Bon candidat, mais même les meilleurs buteurs ne marquent qu’environ 4 matchs sur 10.' : 'Soirée sans buteur évident : petite mise ou passer.',
    historique: { n: hist.length, gagnes: hist.filter((x: any) => x.resultat === 1).length },
  };
}

function teamSnapshot(ctx: Ctx, ab: string) {""")
open(B, 'w', encoding='utf-8').write(s)

P = 'public/index.html'
s = open(P, encoding='utf-8').read()
new = r"""    <h2>Buteur du soir</h2>${bil(S.bilan?.buteur)}
    ${S.buteur ? (()=>{ const b = S.buteur, j = b.joueur, e = b.equipe_info, o = b.adversaire;
      return `<article class="pick" style="border-color:var(--accent)"><div class="top"><div class="who"><b style="font-size:1.5rem">${esc(b.nom)}</b> <span class="sub">${esc(b.equipe)} contre ${esc(b.opp)} · ${esc(b.debut)} (Paris)</span></div><span class="big">${pct(b.p_but)}</span></div>
      <div class="chips"><span class="chip good">Marque au moins 1 but</span><span class="chip">Cote juste ${b.cote_juste}</span><span class="chip">Au moins 1 point : ${pct(b.p_point)}</span></div>
      <p class="sub" style="margin:0">${esc(b.verdict)} Avant cette fiche, mon buteur n°1 de la soirée avait marqué 12 fois sur 27 (44 %) : un buteur n'est jamais « sûr ». À jouer seulement si Winamax paie plus de ${b.cote_juste}.</p>
      <div class="lines">
        <div class="col"><h4>Le joueur</h4><ul class="logic">
          <li>${esc(j.ligne)}${j.partenaires.length?` avec ${esc(j.partenaires.join(' et '))}`:''} · ${esc(j.toi)} de glace${j.toi_recent?` (récemment ${esc(j.toi_recent)})`:''}${j.toi_an?`, dont ${esc(j.toi_an)} en avantage numérique`:''}</li>
          <li>${esc(j.buts)}</li><li>${esc(j.saison_prec)}</li><li>${esc(j.dix_derniers)}</li><li>${esc(j.tirs)} · ${esc(j.reussite)}</li>
          ${j.sequence && j.sequence!=='-'?`<li>${esc(j.sequence)}</li>`:''}<li>Contre ${esc(b.opp)} : ${esc(j.vs_adv)}</li>${j.lecture?`<li>${esc(j.lecture)}</li>`:''}</ul></div>
        <div class="col"><h4>${esc(e.nom)}</h4><ul class="logic"><li>Bilan ${esc(e.bilan)}, ${esc(e.forme)} sur 10 matchs</li><li>${e.bp ?? '—'} buts marqués par match · avantage numérique ${e.an ?? '—'} %</li><li>Buts attendus ce soir : <b>${e.xg_ce_soir}</b>${e.total_marche?` (total du marché : ${e.total_marche})`:''}</li></ul>
          <h4>${esc(o.nom)}</h4><ul class="logic"><li>Bilan ${esc(o.bilan)}, ${esc(o.forme)} sur 10 matchs</li><li>${o.bc ?? '—'} buts encaissés et ${o.tirs_contre ?? '—'} tirs concédés par match · désavantage numérique ${o.dn ?? '—'} %</li><li>Gardien : ${esc(o.gardien)} (${esc(o.gardien_statut)})${o.gardien_sv!=null?`, ${o.gardien_sv} d'arrêts cette saison`:''}${o.gardien_sv_prec!=null?`, ${o.gardien_sv_prec} la saison dernière`:''}</li></ul></div>
      </div>
      ${b.atouts.length?`<div><b>Atouts</b><ul class="logic">${b.atouts.map(a=>`<li>${esc(a)}</li>`).join('')}</ul></div>`:''}
      ${b.risques.length?`<div><b>Risques</b><ul class="logic">${b.risques.map(a=>`<li>${esc(a)}</li>`).join('')}</ul></div>`:''}
      ${b.autres.length?`<div class="sub">Juste derrière : ${b.autres.map(a=>`${esc(a.nom)} (${esc(a.equipe)}, ${pct(a.p_but)})`).join(' · ')}</div>`:''}
      <div class="wmx"><label>Cote Winamax « buteur »<input inputmode="decimal" id="bt-cote" placeholder="ex. 2,40"></label><div class="res sub" id="bt-res"></div></div></article>`; })() : '<div class="empty">Pas de buteur assez fiable ce soir.</div>'}
    <h2>Meilleurs paris à cote 2 ou plus</h2>"""
old = "    <h2>Meilleurs paris à cote 2 ou plus</h2>"
assert old in s
s = s.replace(old, new, 1)
old2 = "function comboCalc(box){"
assert old2 in s
s = s.replace(old2, """document.addEventListener('input', e => { if(e.target.id!=='bt-cote') return; const b = D.selection?.buteur; const c = num(e.target.value), out = $('#bt-res'); if(!b || !c){ out.innerHTML=''; return; } const ev = b.p_but*c-1;
  out.innerHTML = (ev >= 0.05 ? `<span class="chip good">Valeur : +${(ev*100).toFixed(0)} % d'espérance</span>` : ev <= -0.05 ? `<span class="chip bad">Cote trop basse (${(ev*100).toFixed(0)} %)</span>` : `<span class="chip">À peu près juste</span>`) + (ev>0 ? kellyTxt(b.p_but,c) : ''); });
function comboCalc(box){""", 1)
open(P, 'w', encoding='utf-8').write(s)
print('ok')
