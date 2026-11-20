B = 'netlify/functions/lib/pipeline.mts'
s = open(B, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, old[:90]
    s = s.replace(old, new, 1)


# libellés des jambes conservés pour les nouveaux paris
rep("type: `Pari fun ${f.cible}+`, selection: f.legs.map((l: any) => l.label).join(' + '), legs: f.legs.map((l: any) => ({ kind: l.kind, team: l.team, line: l.line, player_id: l.player_id, game_id: l.game_id })),",
    "type: `Pari fun ${f.cible}+`, selection: f.legs.map((l: any) => l.label).join(' + '), legs: f.legs.map((l: any) => ({ kind: l.kind, team: l.team, line: l.line, player_id: l.player_id, game_id: l.game_id, label: l.label, match: l.match, cote: l.cote })),")
rep("type: 'Cote 2+', selection: c.label, legs: [{ kind: c.kind, team: c.team, line: c.line, game_id: c.game_id }],",
    "type: 'Cote 2+', selection: c.label, legs: [{ kind: c.kind, team: c.team, line: c.line, game_id: c.game_id, label: c.label, match: c.match }],")

rep("      signaux: signalBilan(db),", "      signaux: signalBilan(db),\n      paris_suivis: parisSuivis(db),")
rep("/** Bilan des signaux :",
    """/** Tous les paris à cote 2+, combinés, paris fun et paris d'autres parieurs depuis le début, avec gain à mise fixe (1 unité). */
function parisSuivis(db: any) {
  const T = ['Cote 2+', 'Combiné point', 'Pari fun 5+', 'Pari fun 10+', 'Pari parieur Covers'];
  const matchOf = new Map<number, string>();
  for (const r of db.results) matchOf.set(r.game_id, `${r.exterieur} @ ${r.domicile}`);
  for (const p of db.predictions) if (p.match && !matchOf.has(p.game_id)) matchOf.set(p.game_id, p.match);
  const scoreOf = new Map<number, string>(db.results.map((r: any) => [r.game_id, `${r.exterieur} ${r.score_ext}–${r.score_dom} ${r.domicile}`]));
  const rows = db.predictions.filter((p: any) => T.includes(p.type)).map((p: any) => {
    const labels = String(p.selection || '').split(' + ');
    const cote = p.cote ?? (p.type === 'Combiné point' && p.prob ? r3(1 / p.prob, 2) : null);
    const gain = p.resultat === 1 && cote ? r3(cote - 1, 2) : p.resultat === 0 ? -1 : null;
    return {
      date: p.date, type: p.type, selection: p.selection, cote, cote_juste: p.type === 'Combiné point', prob: p.prob, resultat: p.resultat ?? null, gain,
      jambes: (p.legs || [{ game_id: p.game_id }]).map((l: any, i: number) => ({ label: l.label || (p.legs?.length > 1 ? labels[i] : p.selection), match: l.match || matchOf.get(l.game_id) || '', score: scoreOf.get(l.game_id) || null, res: p.legs_res ? p.legs_res[i] : (p.legs ? null : p.resultat) })),
    };
  }).sort((a: any, b: any) => b.date.localeCompare(a.date));
  const bilan = ['Tous', ...T].map(t => {
    const g = rows.filter((r: any) => (t === 'Tous' || r.type === t) && (r.resultat === 0 || r.resultat === 1));
    const withOdds = g.filter((r: any) => r.gain != null);
    const profit = withOdds.reduce((s: number, r: any) => s + r.gain, 0);
    return { type: t, n: g.length, gagnes: g.filter((r: any) => r.resultat === 1).length, en_attente: rows.filter((r: any) => (t === 'Tous' || r.type === t) && r.resultat == null).length, profit: r3(profit, 2), roi: withOdds.length ? r3(profit / withOdds.length, 3) : null };
  });
  return { bilan, paris: rows.slice(0, 300) };
}

/** Bilan des signaux :""")
open(B, 'w', encoding='utf-8').write(s)

P = 'public/index.html'
s = open(P, encoding='utf-8').read()
rep("['apres','Après-match'],", "['apres','Après-match'],['suivi','Mes paris suivis'],")
rep("const views = {selec, soiree, joueurs, equipes, blessures, veille, apres, fiab, appr};", "const views = {selec, soiree, joueurs, equipes, blessures, veille, apres, suivi, fiab, appr};")
rep("// ---- Apprentissage : journal critique quotidien",
    r"""// ---- Mes paris suivis : cotes 2+, combinés, paris fun, paris d'autres parieurs
function suivi(){
  const S = D.paris_suivis;
  if(!S || !(S.paris||[]).length) return '<div class="empty">Aucun pari suivi pour l’instant.</div>';
  const resChip = r => r===1?'<span class="chip good">Gagné</span>':r===0?'<span class="chip bad">Perdu</span>':r==='N/J'?'<span class="chip">Annulé (joueur absent)</span>':'<span class="chip">En attente</span>';
  const legChip = r => r===1?'✓':r===0?'✗':'·';
  const money = v => v==null?'—':`<b style="color:var(${v>0?'--good':v<0?'--bad':'--fg'})">${v>0?'+':''}${Number(v).toFixed(2)} u</b>`;
  const types = ['Tous', ...new Set(S.paris.map(p=>p.type))];
  return `<div class="section">
    <p class="lead">Tous les paris à cote 2 et plus, les combinés, les paris fun et les paris d'autres parieurs proposés depuis le début. Le gain est calculé avec une mise fixe d'1 unité par pari (1 u = la mise de ton choix, par exemple 1 €). Pour les combinés de 2 joueurs, c'est la cote juste qui sert de cote, car nhl.com ne publie pas de cotes joueurs.</p>
    ${table([['Type',b=>[`<b>${esc(b.type)}</b>`,b.type]],['Évalués',b=>[b.n,b.n],1],['Gagnés',b=>[b.n?`${b.gagnes}/${b.n} (${pct(b.gagnes/b.n)})`:'—',b.n?b.gagnes/b.n:-1],1],['En attente',b=>[b.en_attente,b.en_attente],1],['Gain cumulé',b=>[money(b.profit),b.profit??0],1],['Rendement',b=>[b.roi==null?'—':`${b.roi>0?'+':''}${Math.round(b.roi*100)} %`,b.roi??0],1]], S.bilan)}
    <div class="controls"><label for="f-suivi">Afficher</label><select id="f-suivi">${types.map(t=>`<option>${esc(t)}</option>`).join('')}</select></div>
    <div id="suivi-list">${suiviList(S.paris, 'Tous')}</div>
  </div>`;
}
function suiviList(rows, t){
  const resChip = r => r===1?'<span class="chip good">Gagné</span>':r===0?'<span class="chip bad">Perdu</span>':r==='N/J'?'<span class="chip">Annulé</span>':'<span class="chip">En attente</span>';
  const legMark = r => r===1?'<span style="color:var(--good)">✓</span>':r===0?'<span style="color:var(--bad)">✗</span>':'<span class="sub">·</span>';
  const list = rows.filter(p => t==='Tous' || p.type===t);
  return `<div class="picks">${list.map(p=>`<article class="pick"><div class="top"><div class="who"><b>${esc(p.type)}</b> <span class="sub">${frDate(p.date)}</span></div><span class="big">${p.cote ? p.cote : '—'}</span></div>
    <div class="chips">${resChip(p.resultat)}${p.prob!=null?`<span class="chip">Mes chances ${pct(p.prob)}</span>`:''}${p.cote_juste?'<span class="chip">Cote juste</span>':''}${p.gain!=null?`<span class="chip ${p.gain>0?'good':'bad'}">${p.gain>0?'+':''}${p.gain.toFixed(2)} u</span>`:''}</div>
    <ul>${p.jambes.map(j=>`<li>${legMark(j.res)} ${esc(j.label)}${j.match?` <span class="sub">(${esc(j.score || j.match)})</span>`:''}</li>`).join('')}</ul></article>`).join('')}</div>`;
}
document.addEventListener('change', e => { if(e.target.id==='f-suivi'){ $('#suivi-list').innerHTML = suiviList(D.paris_suivis.paris, e.target.value); } });

// ---- Apprentissage : journal critique quotidien""")
open(P, 'w', encoding='utf-8').write(s)
print('ok')
