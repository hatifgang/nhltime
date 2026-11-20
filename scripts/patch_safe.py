B = 'netlify/functions/lib/pipeline.mts'
s = open(B, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, old[:90]
    s = s.replace(old, new, 1)


rep("  // Méga combiné points : le joueur le plus sûr de chaque match",
    """  // ---- Pari safe du jour (modèle « ticket Winamax ») : victoires d'équipe + points de joueurs sûrs, cote 3 à 4,5.
  // Backtest moteur v2 : 5 tickets gagnés sur 12 (42 %) pour une cote moyenne de 3,3.
  const safe = (() => {
    const winL = liveG.flatMap(g => {
      const out: any[] = [];
      for (const [team, p, cote, mk] of [[g.domicile, g.p_dom, g.cote_dom, true], [g.exterieur, g.p_ext, g.cote_ext, true]] as const) {
        if (p < 0.55 || g.confiance === 'Faible') continue;
        const c = cote || r3(1 / p, 2);
        const why = [...(g.pro?.notes || []).slice(0, 2), ...(g.logique || []).filter((t: string) => /Gardien|2e match|Absences|Forme/.test(t)).slice(0, 2)];
        out.push({ kind: 'win', team, game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, label: `${team} gagne (prolongation incluse)`, prob: p, cote: c, marche: !!cote, why });
      }
      return out;
    });
    const ptL = pts.filter((p: any) => p.niveau === 'Choix sûr' || p.prob >= 0.72).map((p: any) => ({
      kind: 'point', player_id: p.id, game_id: p.game_id, match: p.match, label: `${p.nom} : au moins 1 point`, prob: p.prob,
      cote: r3(Math.max(1.15, 0.93 / p.prob), 2), marche: false, why: (p.raisons || []).slice(0, 3) }));
    const pool = [...winL, ...ptL];
    let best: any = null;
    const rec = (start: number, chosen: any[], prob: number, cote: number) => {
      const nW = chosen.filter(c => c.kind === 'win').length, nP = chosen.length - nW;
      if (chosen.length >= 2 && nW >= 1 && nP >= 1 && cote >= 3 && cote <= 4.5) {
        const sc = prob * cote - 0.02 * chosen.length;
        if (!best || sc > best.sc) best = { legs: [...chosen], prob, cote, sc };
      }
      if (chosen.length === 4) return;
      for (let i = start; i < pool.length; i++) {
        const l = pool[i];
        if (chosen.some(c => c.game_id === l.game_id)) continue;
        chosen.push(l); rec(i + 1, chosen, prob * l.prob, cote * l.cote); chosen.pop();
      }
    };
    rec(0, [], 1, 1);
    if (!best) return null;
    return { prob: r3(best.prob, 3), cote: r3(best.cote, 2), cote_juste: r3(1 / best.prob, 2), ev: r3(best.prob * best.cote - 1, 3),
      provisoire: best.legs.some((l: any) => l.kind === 'win' && !l.marche),
      legs: best.legs.map((l: any) => ({ kind: l.kind, team: l.team, player_id: l.player_id, game_id: l.game_id, match: l.match, label: l.label, prob: r3(l.prob), cote: l.cote, marche: l.marche, why: l.why })) };
  })();

  // Méga combiné points : le joueur le plus sûr de chaque match""")
rep("  return { cote2, cote2j, fun, accord,", "  return { safe, cote2, cote2j, fun, accord,")
rep("  for (const f of selection.fun) newPreds.push(",
    "  if (selection.safe) newPreds.push({ ...sbase(selection.safe.legs[0].game_id), v: 2, type: 'Pari safe du jour', selection: selection.safe.legs.map((l: any) => l.label).join(' + '), legs: selection.safe.legs.map((l: any) => ({ kind: l.kind, team: l.team, player_id: l.player_id, game_id: l.game_id, label: l.label, match: l.match, cote: l.cote })), prob: selection.safe.prob, cote: selection.safe.cote });\n"
    "  for (const f of selection.fun) newPreds.push(")
rep("'Pari fun Méga points',", "'Pari fun Méga points', 'Pari safe du jour',")
rep("['buteur', 'Buteur du soir']] as const) {", "['buteur', 'Buteur du soir'], ['safe', 'Pari safe du jour']] as const) {")
s2 = s
open(B, 'w', encoding='utf-8').write(s)

# paris suivis : ajouter le type
s = open(B, encoding='utf-8').read()
old = "  const T = ['Cote 2+', 'Combiné point', 'Pari fun 5+', 'Pari fun 10+', 'Pari parieur Covers'];"
if old in s:
    s = s.replace(old, "  const T = ['Pari safe du jour', 'Cote 2+', 'Combiné point', 'Pari fun 5+', 'Pari fun 10+', 'Pari fun Buteurs', 'Pari fun Victoire + buteur', 'Pari fun Mélange', 'Pari fun Méga points', 'Pari parieur Covers'];")
open(B, 'w', encoding='utf-8').write(s)

P = 'public/index.html'
s = open(P, encoding='utf-8').read()
new = r"""    <h2>Pari safe du jour</h2>${bil(S.bilan?.safe)}
    ${S.safe ? `<article class="pick" style="border-color:var(--good)" id="safe-card"><div class="top"><div class="who"><b style="font-size:1.4rem">Cote ${S.safe.cote}</b> <span class="sub">${S.safe.legs.length} paris, un par match</span></div><span class="big">${pct(S.safe.prob)}</span></div>
      <div class="chips"><span class="chip good">Pari safe</span><span class="chip">Cote juste ${S.safe.cote_juste}</span>${S.safe.ev!=null?`<span class="chip ${S.safe.ev>0?'good':''}">Espérance ${S.safe.ev>0?'+':''}${Math.round(S.safe.ev*100)} %</span>`:''}${S.safe.provisoire?'<span class="chip warn">Cotes du soir pas encore publiées : provisoire</span>':''}</div>
      <p class="sub" style="margin:0">Construit comme un ticket Winamax : des victoires d'équipe où mes favoris gagnent 65 % du temps, plus des points de joueurs parmi mes « choix sûrs » (72 % de réussite). Sur les 12 dernières soirées, ce ticket serait passé 5 fois (42 %) pour une cote moyenne de 3,3. Il perd plus souvent qu'il ne gagne : c'est la cote qui le rend intéressant.</p>
      ${S.safe.legs.map((l,i)=>`<div class="wmx"><div class="top"><b>${esc(l.label)}</b><span class="sub">${esc(l.match)} · mes chances ${pct(l.prob)} · cote ${l.cote}${l.marche?'':' (estimée)'}</span></div>
        ${(l.why||[]).length?`<ul class="logic">${l.why.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>`:''}
        <label>Cote Winamax<input inputmode="decimal" data-safe="${i}" placeholder="ex. ${l.cote}"></label></div>`).join('')}
      <div class="res sub" id="safe-res">Tape les cotes Winamax pour voir la cote réelle du ticket, son espérance et la mise conseillée.</div></article>` : '<div class="empty">Pas de ticket safe ce soir : pas assez de favoris et de joueurs sûrs dans des matchs différents.</div>'}
    <h2>Buteur du soir</h2>"""
old = "    <h2>Buteur du soir</h2>"
assert old in s
s = s.replace(old, new, 1)
old2 = "function comboCalc(box){"
assert old2 in s
s = s.replace(old2, """document.addEventListener('input', e => {
  if(e.target.dataset.safe===undefined) return;
  const S = D.selection?.safe; if(!S) return;
  const odds = [...document.querySelectorAll('[data-safe]')].map((i,k)=>num(i.value) || S.legs[k].cote);
  const cote = odds.reduce((a,b)=>a*b,1), ev = S.prob*cote-1;
  $('#safe-res').innerHTML = `Cote du ticket : <b>${cote.toFixed(2)}</b> (cote juste ${S.cote_juste}). ` + (ev >= 0.05 ? `<span class="chip good">Valeur : +${(ev*100).toFixed(0)} %</span>` : ev <= -0.05 ? `<span class="chip bad">Cote trop basse (${(ev*100).toFixed(0)} %)</span>` : `<span class="chip">À peu près juste</span>`) + (ev>0 ? kellyTxt(S.prob, cote) : '');
});
function comboCalc(box){""", 1)
open(P, 'w', encoding='utf-8').write(s)
print('ok')
