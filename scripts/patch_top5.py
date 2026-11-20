def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for o, n in pairs:
        assert o in s, (path, o[:80])
        s = s.replace(o, n, 1)
    open(path, 'w', encoding='utf-8').write(s)


AVIS = """(notre: number | null, ev: number | null) => { const pc = notre != null ? Math.round(notre * 100) : null; return pc == null ? "Je n'ai pas d'estimation sur ce pari." : pc >= 50 ? (ev != null && ev < 0 ? `D'accord sur le fond (${pc} %) mais la cote est un peu courte.` : `Je suis d'accord : ${pc} % selon moi.`) : `Je ne suis pas d'accord : ${pc} % selon moi.`; }"""

# ---------------------------------------------------------------- NHL
patch('netlify/functions/lib/pipeline.mts', [
    ("  selection.autres = { paris: autres, n_classes: tb.n_classes, seuil_chance: r3(tb.seuil_chance, 2) };\n",
     """  selection.autres = { paris: autres, n_classes: tb.n_classes, seuil_chance: r3(tb.seuil_chance, 2) };
  // ---- Les 5 meilleurs parieurs Covers : classement, chance ou talent, leurs paris du soir avec mon avis, et leur bilan mesuré par moi
  const avisOf = """ + AVIS + """;
  const top5 = tb.parieurs.slice(0, 5).map((b: any, i: number) => {
    const paris = tb.paris.filter((p: any) => p.parieur.nom === b.nom && p.kind !== 'spread').map((p: any) => {
      const g = outGames.find(x => x.exterieur === p.away && x.domicile === p.home);
      if (!g) return null;
      const notre = p.kind === 'win' ? (p.team === g.domicile ? g.p_dom : g.p_ext) : g.ou && g.ou.line === p.line ? (p.kind === 'over' ? g.ou.p_over : g.ou.p_under) : null;
      const ev = notre != null && p.cote ? notre * p.cote - 1 : null;
      return { game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, pari: fr(p), kind: p.kind, team: p.team, line: p.line, cote: p.cote ? r3(p.cote, 2) : null, notre: r3(notre), ev: r3(ev), avis: avisOf(notre, ev), commence: startedIds.has(g.game_id) };
    }).filter(Boolean);
    const me = db.predictions.filter((p: any) => p.type === 'Pari top Covers' && p.parieur === b.nom && (p.resultat === 0 || p.resultat === 1));
    return { rang: i + 1, nom: b.nom, url: b.url, record: `${b.gagnes}-${b.perdus}`, taux: r3(b.taux), unites: b.unites, borne_basse: r3(b.borne_basse), z: r3(b.z, 2), au_dela_chance: b.z >= tb.seuil_chance,
      paris, mesure: { n: me.length, gagnes: me.filter((p: any) => p.resultat === 1).length } };
  });
  selection.top5 = { parieurs: top5, n_classes: tb.n_classes, seuil_chance: r3(tb.seuil_chance, 2) };
  for (const b of top5) for (const a of b.paris as any[]) if (!a.commence) newPreds.push({ ...sbase(a.game_id), v: 2, type: 'Pari top Covers', parieur: b.nom, selection: `${b.nom} : ${a.pari}`, legs: [{ kind: a.kind, team: a.team, line: a.line, game_id: a.game_id }], prob: a.notre ?? 0.5, cote: a.cote });
"""),
    ("['autres', 'Pari parieur Covers'], ['buteur', 'Buteur du soir']", "['autres', 'Pari parieur Covers'], ['top5', 'Pari top Covers'], ['buteur', 'Buteur du soir']"),
])

# ---------------------------------------------------------------- NBA
patch('netlify/functions/lib/nba/selection.mts', [
    ("  for (const a of autres) preds.push({ type: 'Pari parieur Covers',",
     """  const avisOf = """ + AVIS + """;
  const labOf = (x: any) => x.kind === 'win' ? `${x.team} gagne` : x.kind === 'spread' ? `${x.team} ${x.line > 0 ? '+' : ''}${x.line} (handicap)` : `${x.kind === 'over' ? 'Plus' : 'Moins'} de ${x.line} points`;
  const top5 = (tb?.parieurs || []).slice(0, 5).map((b: any, i: number) => {
    const paris = (tb.paris || []).filter((x: any) => x.parieur.nom === b.nom).map((x: any) => {
      const g = games.find(y => y.exterieur === x.away && y.domicile === x.home); if (!g) return null;
      const notre = pFor(g, x.kind, x.team, x.line), cote = x.cote || (x.kind !== 'win' ? 1.91 : null), ev = notre != null && cote ? notre * cote - 1 : null;
      return { game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, pari: labOf(x), kind: x.kind, team: x.team, line: x.line, cote: r3(cote, 2), notre: r3(notre), ev: r3(ev), avis: avisOf(notre, ev), commence: started.has(g.game_id) };
    }).filter(Boolean);
    const me = (db.predictions || []).filter((p: any) => p.type === 'Pari top Covers' && p.parieur === b.nom && (p.resultat === 0 || p.resultat === 1));
    return { rang: i + 1, nom: b.nom, url: b.url, record: `${b.gagnes}-${b.perdus}`, taux: r3(b.taux), unites: b.unites, borne_basse: r3(b.borne_basse), z: r3(b.z, 2), au_dela_chance: b.z >= (tb.seuil_chance || 3), paris, mesure: { n: me.length, gagnes: me.filter((p: any) => p.resultat === 1).length } };
  });
  for (const b of top5) for (const a of b.paris as any[]) if (!a.commence) preds.push({ type: 'Pari top Covers', parieur: b.nom, game_id: a.game_id, selection: `${b.nom} : ${a.pari}`, prob: a.notre ?? 0.5, cote: a.cote, legs: [{ kind: a.kind, team: a.team, line: a.line, game_id: a.game_id }] });
  for (const a of autres) preds.push({ type: 'Pari parieur Covers',"""),
    ("autres: { paris: autres, n_classes: tb?.n_classes || 0, seuil_chance: r3(tb?.seuil_chance, 2) },",
     "autres: { paris: autres, n_classes: tb?.n_classes || 0, seuil_chance: r3(tb?.seuil_chance, 2) }, top5: { parieurs: top5, n_classes: tb?.n_classes || 0, seuil_chance: r3(tb?.seuil_chance, 2) },"),
    ("['autres', 'Pari parieur Covers'],", "['autres', 'Pari parieur Covers'], ['top5', 'Pari top Covers'],"),
])

# ---------------------------------------------------------------- pages (même bloc sur les deux)
BLOCK = r"""    <h2>Les 5 meilleurs parieurs Covers</h2>${bil(S.bilan?.top5)}
    <p class="lead">Classés par la solidité de leur historique (borne basse de leur taux de réussite, au moins 40 paris), pas par leurs gains bruts. Sur ${S.top5?.n_classes||'des milliers de'} parieurs classés, le meilleur dépasse naturellement un score z de ${S.top5?.seuil_chance??'3,8'} par pure chance : en dessous, ce peut être de la chance. Je note chacun de leurs paris pour mesurer moi-même s'ils gagnent vraiment.</p>
    ${(S.top5?.parieurs||[]).length ? `<div class="picks">${S.top5.parieurs.map(b=>`<article class="pick"><div class="top"><span class="rank">${b.rang}</span><div class="who"><b>${esc(b.nom)}</b> <span class="sub">${esc(b.record)} · ${pct(b.taux)} de réussite${b.unites!=null?` · ${b.unites>0?'+':''}${b.unites} unités`:''}</span></div><span class="big">${pct(b.borne_basse)}</span></div>
      <div class="chips">${b.au_dela_chance?'<span class="chip good">Au-delà de la chance</span>':'<span class="chip warn">Peut-être de la chance</span>'}<span class="chip">Score z ${b.z}</span><span class="chip">${b.mesure.n?`Mesuré par moi : ${b.mesure.gagnes}/${b.mesure.n} (${pct(b.mesure.gagnes/b.mesure.n)})`:'Mesuré par moi : pas encore de pari noté'}</span></div>
      <p class="sub" style="margin:0">Le grand pourcentage est son taux de réussite minimum avec 95 % de confiance.</p>
      ${b.paris.length?`<ul>${b.paris.map(a=>`<li><b>${esc(a.pari)}</b> <span class="sub">(${esc(a.match)}${a.cote?`, cote ${a.cote}`:''}${a.commence?', commencé':''})</span> : ${esc(a.avis)}${a.ev!=null?` Espérance ${a.ev>0?'+':''}${Math.round(a.ev*100)} %.`:''}</li>`).join('')}</ul>`:'<p class="sub" style="margin:0">Pas de pari publié pour ce soir.</p>'}
      <a class="sub" href="${esc(b.url)}" target="_blank" rel="noopener">Voir son profil Covers</a></article>`).join('')}</div>` : '<div class="empty">Classement covers.com non disponible pour le moment.</div>'}
"""
patch('public/index.html', [("    <h2>2 paris d'autres parieurs</h2>${bil(S.bilan?.autres)}", BLOCK + "    <h2>2 paris d'autres parieurs</h2>${bil(S.bilan?.autres)}")])
for f in ['public/nba.html', 'scripts/nba_page_script.js']:
    patch(f, [("    <h2>2 paris d'autres parieurs</h2>${bil(S.bilan?.autres)}", BLOCK + "    <h2>2 paris d'autres parieurs</h2>${bil(S.bilan?.autres)}")])
# suivi des paris : ajouter le type
patch('netlify/functions/lib/nba/selection.mts', [("'Pari parieur Covers', 'Totaux : match le plus sûr', 'Totaux : période la plus sûre'];", "'Pari parieur Covers', 'Pari top Covers', 'Totaux : match le plus sûr', 'Totaux : période la plus sûre'];")])
s = open('netlify/functions/lib/pipeline.mts', encoding='utf-8').read()
import re
m = re.search(r"const T = \[[^\]]*'Pari parieur Covers'\];", s)
if m:
    s = s.replace(m.group(0), m.group(0).replace("'Pari parieur Covers'];", "'Pari parieur Covers', 'Pari top Covers'];"))
    open('netlify/functions/lib/pipeline.mts', 'w', encoding='utf-8').write(s)
print('ok', bool(m))
