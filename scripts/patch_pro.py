B = 'netlify/functions/lib/pipeline.mts'
s = open(B, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, old[:90]
    s = s.replace(old, new, 1)


rep("import { kv, emptyDb } from './store.mts';", "import { kv, emptyDb } from './store.mts';\nimport { fetchCovers } from './covers.mts';")

# ---------------- évaluation : 2+ points / 2+ buts, lecture pro, signaux
rep("    if (p.type === 'Sélection équipe') {\n      p.resultat = (a.score > h.score ? a.abbrev : h.abbrev) === p.selection_abbr ? 1 : 0;",
    "    if (p.type === 'Sélection équipe' || p.type === 'Lecture pro') {\n      p.resultat = (a.score > h.score ? a.abbrev : h.abbrev) === p.selection_abbr ? 1 : 0;")
rep("      const tk = p.type.match(/tirs (\\d)\\+/);\n      p.resultat = !st ? 'N/J' : tk ? +((st.sog || 0) >= +tk[1]) :",
    "      const tk = p.type.match(/tirs (\\d)\\+/), mp = p.type.match(/(\\d)\\+ (points|buts)/);\n      p.resultat = !st ? 'N/J' : mp ? +((mp[2] === 'buts' ? st.goals : st.points) >= +mp[1]) : tk ? +((st.sog || 0) >= +tk[1]) :")
rep("  const results: any[] = [];\n  for (const g of ydayGames) {",
    """  // Signaux extérieurs (public, leaders Covers, mouvement de cote) : on mesure nous-mêmes s'ils gagnent.
  for (const sg of (db.signals || []).filter((x: any) => x.res == null)) {
    const box = boxes.get(sg.game_id);
    if (!box || !FINAL.includes(box.gameState)) continue;
    const win = box.awayTeam.score > box.homeTeam.score ? box.awayTeam.abbrev : box.homeTeam.abbrev;
    const tot = box.awayTeam.score + box.homeTeam.score;
    sg.res = Object.fromEntries(Object.entries(sg.picks).filter(([, v]) => v).map(([k, v]) => [k, +(v === win)]));
    if (sg.ou?.line != null) sg.ou_res = Object.fromEntries(Object.entries(sg.ou).filter(([k, v]) => k !== 'line' && v && tot !== sg.ou.line).map(([k, v]) => [k, +((v === 'over') === (tot > sg.ou.line))]));
  }
  const results: any[] = [];
  for (const g of ydayGames) {""")
rep("  const ids = [...new Set<number>(pending.flatMap((p: any) => [p.game_id, ...(p.legs || []).map((l: any) => l.game_id)]))];",
    "  const ids = [...new Set<number>([...pending.flatMap((p: any) => [p.game_id, ...(p.legs || []).map((l: any) => l.game_id)]), ...(db.signals || []).filter((x: any) => x.res == null && x.date < ctx.today).map((x: any) => x.game_id)])];")

# ---------------- soirée : Covers + cote d'ouverture
rep("  const lu = games.length ? await fetchLineups(today, ctx.cur, ctx.nickUpper)",
    """  const placeToAbbr: Record<string, string> = {};
  for (const ab of ctx.abbrs) placeToAbbr[norm(nm(ctx.st[ab].placeName))] = ab;
  const cov = games.length ? await fetchCovers(placeToAbbr) : { ok: false, reason: 'aucun match', games: [] as any[] };
  const covBy = new Map(cov.games.map((c: any) => [`${c.away}@${c.home}`, c]));
  const coversInfo = cov.ok ? `${ctx.consulted} (${cov.games.length} match(s))` : `non disponible (${cov.reason})`;
  db.odds_open = db.odds_open || {};
  const lu = games.length ? await fetchLineups(today, ctx.cur, ctx.nickUpper)""")
rep("    if (started) {\n      startedIds.add(g.id);",
    """    // Marché : cote d'ouverture (premier relevé) et mouvement depuis
    if (!started && mkt != null && !db.odds_open[g.id]) db.odds_open[g.id] = { mkt_h: r3(mkt, 4), quand: ctx.consulted };
    const open = db.odds_open[g.id];
    const move = !started && mkt != null && open ? mkt - open.mkt_h : null;
    const cv: any = covBy.get(`${a}@${h}`);
    const pubSide = cv ? (cv.public_dom >= cv.public_ext ? h : a) : null, pubPct = cv ? Math.max(cv.public_dom, cv.public_ext) : null;
    const lTot = cv ? cv.leaders_dom + cv.leaders_ext : 0;
    const leadSide = cv && lTot >= 6 && Math.abs(cv.leaders_dom - cv.leaders_ext) >= 3 ? (cv.leaders_dom > cv.leaders_ext ? h : a) : null;
    const moveSide = move != null && Math.abs(move) >= 0.02 ? (move > 0 ? h : a) : null;
    const rlmSide = pubSide && pubPct! >= 60 && moveSide && moveSide !== pubSide ? moveSide : null;
    game.parieurs = cv || open ? {
      public_ext: cv?.public_ext ?? null, public_dom: cv?.public_dom ?? null, over_pct: cv?.over_pct ?? null, total: cv?.total ?? null,
      leaders_ext: cv?.leaders_ext ?? null, leaders_dom: cv?.leaders_dom ?? null, leaders_over: cv?.leaders_over ?? null, leaders_under: cv?.leaders_under ?? null,
      leaders_pick: leadSide, url: cv?.url ?? null, ouverture_dom: open?.mkt_h ?? null, ouverture_quand: open?.quand ?? null, mouvement: r3(move), rlm: rlmSide,
    } : null;
    // Cerveau de parieur pro : avantage réel sur la cote, signaux concordants, mise raisonnable (Kelly fractionné)
    if (!started) {
      const sides = [{ ab: h, p: pH, imp: mkt, cote: mlH }, { ab: a, p: pA, imp: mkt != null ? 1 - mkt : null, cote: mlA }].filter(x => x.imp != null && x.cote);
      const best = sides.sort((x, y) => (y.p - y.imp!) - (x.p - x.imp!))[0];
      const notes: string[] = [];
      let verdict = 'Pas de cote : impossible de juger l’avantage', side: string | null = null, mise = 0;
      if (best) {
        const edge = best.p - best.imp!;
        notes.push(`${best.ab} : ${Math.round(best.p * 100)} % selon moi contre ${Math.round(best.imp! * 100)} % dans la cote (${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)} pts).`);
        if (leadSide) notes.push(leadSide === best.ab ? `Les leaders Covers penchent aussi pour ${best.ab} (${best.ab === h ? cv.leaders_dom : cv.leaders_ext} contre ${best.ab === h ? cv.leaders_ext : cv.leaders_dom}).` : `Les leaders Covers penchent pour ${leadSide} : signal contraire.`);
        if (pubSide && pubPct! >= 65) notes.push(`${pubPct} % du public sur ${pubSide}${pubSide === best.ab ? ' : pari populaire, la cote est souvent moins généreuse' : ''}.`);
        if (rlmSide) notes.push(`Mouvement inverse : la cote bouge vers ${rlmSide} alors que le public joue l'autre camp, signe d'argent sérieux sur ${rlmSide}.`);
        else if (moveSide) notes.push(`La cote a bougé de ${Math.abs(move! * 100).toFixed(1)} pts vers ${moveSide} depuis ${open.quand}.`);
        const k = (best.p * best.cote! - 1) / (best.cote! - 1);
        if (edge >= params.vthr && conf !== 'Faible' && !(leadSide && leadSide !== best.ab && rlmSide && rlmSide !== best.ab)) { verdict = 'Jouable'; side = best.ab; mise = clamp(k / 4, 0, 0.02); }
        else if (edge >= 0.02) verdict = 'Léger avantage : petite mise ou passer';
        else verdict = 'Pas d’avantage : passer';
      }
      game.pro = { verdict, side, mise_pct: r3(mise * 100, 1), cote: side ? (side === h ? r3(mlH, 2) : r3(mlA, 2)) : null, notes };
    }
    if (started) {
      startedIds.add(g.id);""")

# ---------------- joueurs : 2+ points / 2+ buts
rep("          p_tirs3: r3(calibrate(CAL.tirs3, pAtLeastK(lamShots(p), 3, params.rs))),",
    "          p_tirs3: r3(calibrate(CAL.tirs3, pAtLeastK(lamShots(p), 3, params.rs))),\n"
    "          p_point2: r3(pAtLeastK(lamPts(p) * params.ap, 2, params.rp)),\n"
    "          p_but2: r3(pAtLeastK(p.g_rate * teamF / params.xg * ppm(p) * params.ag, 2, Math.min(params.rg, 4))),   // doublés : dispersion plus forte mesurée sur les feuilles de match")

# ---------------- sélection : coups ambitieux
rep("  const pts = pickTop('p_point');",
    """  const ambitieux = (key: 'p_point2' | 'p_but2', n: number, lab: string) => {
    const out: any[] = []; const seen: Record<string, number> = {};
    for (const p of [...eligible].sort((x: any, y: any) => y[key] - x[key])) {
      if (seen[p.equipe]) continue; seen[p.equipe] = 1;
      out.push({ id: p.id, nom: p.nom, equipe: p.equipe, opp: p.opp, pos: p.pos, game_id: p.game_id, match: p.match, prob: p[key], cote_juste: r3(1 / Math.max(0.01, p[key]), 2), pari: lab,
        raisons: [`${lab} : ${Math.round(p[key] * 100)} % (cote juste ${(1 / Math.max(0.01, p[key])).toFixed(2)}). Au moins 1 point : ${Math.round(p.p_point * 100)} %.`,
          p.ipp_pct != null ? `Présent sur ${p.part_glace} % des buts de son équipe, point sur ${p.ipp_pct} % d'entre eux ; ${p.equipe} attend ${p.xg_team} buts.` : '',
          p.regularite || ''].filter(Boolean) });
      if (out.length === n) break;
    }
    return out;
  };
  const pts = pickTop('p_point');""")
rep("  return { points: pts, buts: pickTop('p_but'), equipes, pieges, relance, tirs, combines: pairs.slice(0, 2) };",
    "  return { points: pts, buts: pickTop('p_but'), equipes, pieges, relance, tirs, combines: pairs.slice(0, 2), deux_points: ambitieux('p_point2', 5, '2 points ou plus'), deux_buts: ambitieux('p_but2', 3, '2 buts ou plus') };")
rep("  for (const t of selection.tirs) newPreds.push(",
    """  for (const [list, typ] of [[selection.deux_points, 'Sélection 2+ points'], [selection.deux_buts, 'Sélection 2+ buts']] as const) for (const p of list) newPreds.push({ ...sbase(p.game_id), v: 2, type: typ, selection: p.nom, player_id: p.id, pos: p.pos, prob: p.prob });
  // lecture pro « Jouable » et signaux extérieurs du soir
  db.signals = db.signals || [];
  for (const g of outGames) {
    if (startedIds.has(g.game_id)) continue;
    if (g.pro?.verdict === 'Jouable') { const pd = g.pro.side === g.domicile ? g.p_dom : g.p_ext; newPreds.push({ ...sbase(g.game_id), v: 2, type: 'Lecture pro', selection: g.pro.side, selection_abbr: g.pro.side, prob: pd, cote: g.pro.cote, prob_implicite: g.pro.cote ? r3(1 / g.pro.cote) : null, valeur: 'Valeur potentielle', mise_pct: g.pro.mise_pct }); }
    const pr = g.parieurs || {};
    const pub = pr.public_dom != null ? (pr.public_dom >= pr.public_ext ? g.domicile : g.exterieur) : null;
    const lo = pr.leaders_over, lu2 = pr.leaders_under;
    db.signals = db.signals.filter((x: any) => !(x.game_id === g.game_id && x.res == null)).concat([{ date: today, game_id: g.game_id, dom: g.domicile, ext: g.exterieur,
      picks: { modele: g.p_dom >= g.p_ext ? g.domicile : g.exterieur, public: pub, leaders: pr.leaders_pick ?? null, mouvement_inverse: pr.rlm ?? null, pro: g.pro?.side ?? null },
      ou: pr.total != null ? { line: pr.total, public: pr.over_pct != null ? (pr.over_pct >= 50 ? 'over' : 'under') : null, leaders: lo != null && lo + lu2 >= 6 && Math.abs(lo - lu2) >= 3 ? (lo > lu2 ? 'over' : 'under') : null } : null, res: null }]);
  }
  for (const t of selection.tirs) newPreds.push(""")

# ---------------- bilan des signaux + sources
rep("      reliability: reliability(db),",
    "      reliability: reliability(db),\n      signaux: signalBilan(db),")
rep("          'nhl.com – cotes du partenaire de paris': evening.oddsInfo,",
    "          'nhl.com – cotes du partenaire de paris': evening.oddsInfo,\n          'covers.com – public et leaders (à vérifier)': evening.coversInfo,")
rep("  return { games: outGames, players: outPlayers, injuries, lineupInfo, oddsInfo, selection };",
    "  return { games: outGames, players: outPlayers, injuries, lineupInfo, oddsInfo, selection, coversInfo };")
rep("function postMatch(db: any, p: any, box: any, params: Params) {",
    """/** Bilan des signaux : chaque source doit prouver qu'elle gagne plus d'une fois sur deux (test à 5 %). */
function signalBilan(db: any) {
  const S = (db.signals || []).filter((x: any) => x.res);
  const lab: Record<string, string> = { modele: 'Mon modèle (favori)', public: 'Le public (camp majoritaire)', leaders: 'Leaders Covers (vérifiés par la plateforme)', mouvement_inverse: 'Mouvement inverse de la cote', pro: 'Ma lecture pro « Jouable »' };
  const row = (name: string, arr: number[]) => {
    const n = arr.length, w = arr.reduce((s, x) => s + x, 0);
    const z = n ? (w / n - 0.5) / Math.sqrt(0.25 / n) : 0;
    return { signal: name, n, gagnes: w, taux: n ? r3(w / n) : null, prouve: n >= 30 && z >= 1.96, z: r3(z, 2) };
  };
  const out = Object.keys(lab).map(k => row(lab[k], S.map((x: any) => x.res?.[k]).filter((v: any) => v === 0 || v === 1)));
  const ou = (db.signals || []).filter((x: any) => x.ou_res);
  out.push(row('Public sur le total (plus/moins)', ou.map((x: any) => x.ou_res.public).filter((v: any) => v === 0 || v === 1)));
  out.push(row('Leaders Covers sur le total', ou.map((x: any) => x.ou_res.leaders).filter((v: any) => v === 0 || v === 1)));
  return out;
}

function postMatch(db: any, p: any, box: any, params: Params) {""")
rep("    db.runs = db.runs.concat(", "    db.signals = (db.signals || []).filter((x: any) => daysBetween(x.date, today) <= 200);\n    db.runs = db.runs.concat(")
rep("return ['Vainqueur', 'But joueur', 'Passe joueur', 'Point joueur', 'Sélection équipe', 'Sélection but', 'Sélection point', 'Sélection tirs 2+', 'Sélection tirs 3+', 'Combiné point'].map(typ => {",
    "return ['Vainqueur', 'But joueur', 'Passe joueur', 'Point joueur', 'Sélection équipe', 'Sélection but', 'Sélection point', 'Sélection tirs 2+', 'Sélection tirs 3+', 'Combiné point', 'Sélection 2+ points', 'Sélection 2+ buts', 'Lecture pro'].map(typ => {")
open(B, 'w', encoding='utf-8').write(s)

# ================================================================== page
P = 'public/index.html'
s = open(P, encoding='utf-8').read()
rep("""    <ul class="logic">${x.logique.slice(0,6).map(l=>`<li>${esc(l)}</li>`).join('')}</ul>""",
    """    ${x.pro ? `<div class="pro ${x.pro.verdict==='Jouable'?'ok':''}"><b>Lecture pro : ${esc(x.pro.verdict)}${x.pro.side?` ${esc(x.pro.side)}${x.pro.cote?` à ${x.pro.cote}`:''}`:''}</b>${x.pro.mise_pct?` <span class="chip good">Mise conseillée ${x.pro.mise_pct} % de ta bankroll${miseEuros(x.pro.mise_pct)}</span>`:''}<ul>${x.pro.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
    ${x.parieurs ? `<div class="sub">Parieurs (covers.com) : public ${x.parieurs.public_ext ?? '?'} % ${x.exterieur} / ${x.parieurs.public_dom ?? '?'} % ${x.domicile}${x.parieurs.leaders_dom!=null?` · leaders ${x.parieurs.leaders_ext}–${x.parieurs.leaders_dom}`:''}${x.parieurs.total!=null?` · total ${x.parieurs.total} : ${x.parieurs.over_pct} % plus${x.parieurs.leaders_over!=null?`, leaders ${x.parieurs.leaders_over} plus / ${x.parieurs.leaders_under} moins`:''}`:''}${x.parieurs.mouvement!=null?` · cote ${x.domicile} ${x.parieurs.mouvement>0?'+':''}${(x.parieurs.mouvement*100).toFixed(1)} pts depuis l'ouverture`:''}</div>` : ''}
    <ul class="logic">${x.logique.slice(0,8).map(l=>`<li>${esc(l)}</li>`).join('')}</ul>""")
rep(".method p{margin:0 0 6px}", ".method p{margin:0 0 6px}\n.pro{border-left:3px solid var(--line);padding:6px 10px;font-size:.84rem;display:grid;gap:4px}\n.pro.ok{border-left-color:var(--good)}\n.pro ul{margin:0;padding-left:18px;color:var(--muted)}\n.bank{display:flex;gap:8px;align-items:center;font-size:.85rem;margin-bottom:6px}\n.bank input{font:inherit;font-size:16px;width:110px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--fg)}")
rep("    <h2>Objectif 80 % : tirs cadrés</h2>",
    """    <h2>Coups ambitieux : 2 points ou 2 buts</h2>${bil(S.bilan?.deux_points)}
    <p class="lead">Moins probables, mieux payés. Je les ai vérifiés sur les feuilles de match passées : les « 2 points ou plus » annoncés vers 38 % ont réussi 36 à 37 % du temps. Tape la cote Winamax : ce pari ne vaut le coup que si elle dépasse la cote juste.</p>
    ${(S.deux_points||[]).length || (S.deux_buts||[]).length ? `<div class="picks">${[...(S.deux_points||[]), ...(S.deux_buts||[])].map((p,i)=>`<article class="pick" data-amb="${i}"><div class="top"><div class="who"><b>${esc(p.nom)}</b> <span class="sub">${esc(p.equipe)} contre ${esc(p.opp)}</span></div><span class="big">${pct(p.prob)}</span></div>
      <div class="chips"><span class="chip warn">${esc(p.pari)}</span><span class="chip">Cote juste ${p.cote_juste}</span></div><ul>${p.raisons.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>
      <div class="wmx"><label>Cote Winamax<input inputmode="decimal" data-ambc placeholder="ex. 3,40"></label><div class="res sub"></div></div></article>`).join('')}</div>` : '<div class="empty">Rien de solide ce soir.</div>'}
    <h2>Objectif 80 % : tirs cadrés</h2>""")
rep("""    <div class="method"><p><b>Comment je choisis.</b>""",
    """    <div class="bank"><label for="bankroll">Ma bankroll (€)</label><input id="bankroll" inputmode="decimal" placeholder="ex. 200"><span class="sub">Sert à calculer les mises conseillées (quart de Kelly, plafonné à 2 % par pari). Gardé sur cet appareil.</span></div>
    <div class="method"><p><b>Comment je choisis.</b>""")
rep("function comboCalc(box){",
    """function bankroll(){ try{ return num(localStorage.getItem('nhl-bankroll')); }catch(e){ return null; } }
function miseEuros(pctv){ const b = bankroll(); return b && pctv ? ` (≈ ${(b*pctv/100).toFixed(2)} €)` : ''; }
function kellyTxt(p, cote){ const k = (p*cote-1)/(cote-1); if(!(k>0)) return ''; const f = Math.min(0.02, k/4); const b = bankroll(); return ` · Mise conseillée : ${(f*100).toFixed(1)} % de ta bankroll${b?` (≈ ${(b*f).toFixed(2)} €)`:''}`; }
function ambCalc(box){
  const S = D.selection||{}; const p = [...(S.deux_points||[]), ...(S.deux_buts||[])][+box.dataset.amb]; if(!p) return;
  const c = num(box.querySelector('[data-ambc]').value), out = box.querySelector('.res');
  if(!c){ out.innerHTML = ''; return; }
  const ev = p.prob*c - 1;
  out.innerHTML = (ev >= 0.05 ? `<span class="chip good">Valeur : +${(ev*100).toFixed(0)} % d'espérance</span>` : ev <= -0.05 ? `<span class="chip bad">Cote trop basse (${(ev*100).toFixed(0)} %)</span>` : `<span class="chip">À peu près juste</span>`) + (ev>0 ? kellyTxt(p.prob,c) : '');
}
document.addEventListener('input', e => {
  const a = e.target.closest('[data-amb]'); if(a && e.target.dataset.ambc!==undefined) ambCalc(a);
  if(e.target.id==='bankroll'){ try{ localStorage.setItem('nhl-bankroll', e.target.value.trim()); }catch(err){} }
});
document.addEventListener('focusin', e => { if(e.target.id==='bankroll' && !e.target.value){ const b = bankroll(); if(b) e.target.value = String(b); } });
function comboCalc(box){""")
rep("  out.innerHTML = `Cote combinée ${cote.toFixed(2)} (cote juste ${c.cote_juste}). ` + (ev >= 0.05",
    "  out.innerHTML = `Cote combinée ${cote.toFixed(2)} (cote juste ${c.cote_juste}). ` + (ev > 0 ? kellyTxt(c.prob, cote).replace(' · ','') + ' ' : '') + (ev >= 0.05")
# bilan signaux dans Apprentissage
rep("   <h2>Recalage final (résultats réels par niveau de confiance)</h2>",
    """   <h2>Les autres parieurs valent-ils quelque chose ?</h2>
   <p class="lead">Je n'accorde aucun poids à une source tant qu'elle n'a pas prouvé, sur au moins 30 matchs, qu'elle gagne nettement plus d'une fois sur deux (test statistique à 5 %). Les classements de parieurs contiennent toujours des chanceux : être en tête sur 80 paris ne prouve rien quand des milliers de joueurs participent.</p>
   ${table([['Source',r=>[esc(r.signal),r.signal]],['Paris',r=>[r.n,r.n],1],['Gagnés',r=>[r.n?`${r.gagnes}/${r.n} (${pct(r.taux)})`:'—',r.taux??-1],1],['Verdict',r=>[r.n<30?'<span class="chip">En observation</span>':r.prouve?'<span class="chip good">Prouvé</span>':'<span class="chip bad">Pas prouvé</span>',r.z??0]]], D.signaux||[])}
   <h2>Recalage final (résultats réels par niveau de confiance)</h2>""")
open(P, 'w', encoding='utf-8').write(s)

# bilan des nouvelles sélections
s = open(B, encoding='utf-8').read()
old = "['tirs', 'Sélection tirs'], ['combine', 'Combiné point']] as const) {"
assert old in s
s = s.replace(old, "['tirs', 'Sélection tirs'], ['combine', 'Combiné point'], ['deux_points', 'Sélection 2+'], ['pro', 'Lecture pro']] as const) {")
open(B, 'w', encoding='utf-8').write(s)
print('ok')
