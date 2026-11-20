B = 'netlify/functions/lib/'


def patch(path, pairs):
    s = open(B + path, encoding='utf-8').read()
    for o, n in pairs:
        assert o in s, (path, o[:80])
        s = s.replace(o, n, 1)
    open(B + path, 'w', encoding='utf-8').write(s)


patch('covers.mts', [
    ("  return { ok: bettors.length > 0, reason: '', parieurs: bettors.slice(0, 10), paris: picks };",
     "  // Seuil « au-delà de la chance » : le meilleur de N parieurs atteint naturellement un z d'environ racine(2 ln N).\n"
     "  const pages = Math.max(1, ...[...page.matchAll(/pageNum=(\\d+)/g)].map(m => +m[1]));\n"
     "  const seuil = Math.sqrt(2 * Math.log(pages * 50));\n"
     "  return { ok: bettors.length > 0, reason: '', parieurs: bettors.slice(0, 10), paris: picks, n_classes: pages * 50, seuil_chance: seuil };"),
    ("  if (!page) return { ok: false, reason: 'classement Covers inaccessible', parieurs: [] as Bettor[], paris: [] as BettorPick[] };",
     "  if (!page) return { ok: false, reason: 'classement Covers inaccessible', parieurs: [] as Bettor[], paris: [] as BettorPick[], n_classes: 0, seuil_chance: 0 };"),
])
patch('pipeline.mts', [
    ("import { fetchCovers } from './covers.mts';", "import { fetchCovers, fetchTopBettors } from './covers.mts';"),
    ("  const coversInfo = cov.ok ?", "  const tb = games.length ? await fetchTopBettors(placeToAbbr) : { ok: false, reason: '', parieurs: [] as any[], paris: [] as any[], n_classes: 0, seuil_chance: 0 };\n  const coversInfo = cov.ok ?"),
    ("  for (const c of selection.cote2) newPreds.push(",
     """  // ---- 2 paris d'autres parieurs (Covers), avec mon avis et la vérification de leur historique
  const fr = (p: any) => p.kind === 'win' ? `${p.team} gagne (cote ${p.cote ? p.cote.toFixed(2) : '?'})` : `${p.kind === 'over' ? 'Plus' : 'Moins'} de ${p.line} buts`;
  const autres: any[] = [];
  for (const b of tb.parieurs) {
    if (autres.length === 2) break;
    const mine = tb.paris.filter((p: any) => p.parieur.nom === b.nom).map((p: any) => {
      const g = outGames.find(x => x.exterieur === p.away && x.domicile === p.home);
      if (!g || startedIds.has(g.game_id)) return null;
      const notre = p.kind === 'win' ? (p.team === g.domicile ? g.p_dom : g.p_ext) : g.ou && g.ou.line === p.line ? (p.kind === 'over' ? g.ou.p_over : g.ou.p_under) : null;
      return { p, g, notre };
    }).filter(Boolean) as any[];
    if (!mine.length) continue;
    const pick = mine.sort((x, y) => (y.notre ?? 0) - (x.notre ?? 0))[0];
    const ev = pick.notre != null && pick.p.cote ? pick.notre * pick.p.cote - 1 : null;
    const pc = pick.notre != null ? Math.round(pick.notre * 100) : null;
    autres.push({ game_id: pick.g.game_id, match: `${pick.g.exterieur} @ ${pick.g.domicile}`, pari: fr(pick.p), kind: pick.p.kind, team: pick.p.team, line: pick.p.line, cote: pick.p.cote ? r3(pick.p.cote, 2) : null,
      parieur: { nom: b.nom, url: b.url, record: `${b.gagnes}-${b.perdus}`, taux: r3(b.taux), borne_basse: r3(b.borne_basse), z: r3(b.z, 2), au_dela_chance: b.z >= tb.seuil_chance },
      notre: pick.notre != null ? r3(pick.notre) : null, ev: ev != null ? r3(ev) : null,
      avis: pc == null ? "Je n'ai pas d'estimation sur ce pari." : pc >= 50 ? (ev != null && ev < 0 ? `Je suis d'accord sur le fond (${pc} %) mais la cote est un peu courte.` : `Je suis d'accord : ${pc} % selon moi.`) : `Je ne suis pas d'accord : ${pc} % selon moi.` });
  }
  selection.autres = { paris: autres, n_classes: tb.n_classes, seuil_chance: r3(tb.seuil_chance, 2) };
  for (const a of autres) newPreds.push({ ...sbase(a.game_id), v: 2, type: 'Pari parieur Covers', selection: `${a.parieur.nom} : ${a.pari}`, legs: [{ kind: a.kind, team: a.team, line: a.line, game_id: a.game_id }], prob: a.notre ?? 0.5, cote: a.cote });
  for (const c of selection.cote2) newPreds.push("""),
    ("'Lecture pro', 'Cote 2+', 'Pari fun 5+', 'Pari fun 10+'].map(typ => {", "'Lecture pro', 'Cote 2+', 'Pari fun 5+', 'Pari fun 10+', 'Pari parieur Covers'].map(typ => {"),
    ("['cote2', 'Cote 2+'], ['fun', 'Pari fun']] as const) {", "['cote2', 'Cote 2+'], ['fun', 'Pari fun'], ['autres', 'Pari parieur Covers']] as const) {"),
])

P = 'public/index.html'
s = open(P, encoding='utf-8').read()
old = "    <h2>Accord avec les autres parieurs</h2>"
assert old in s
new = r"""    <h2>2 paris d'autres parieurs</h2>${bil(S.bilan?.autres)}
    <p class="lead">Les paris du soir des meilleurs parieurs Covers. Leur historique est enregistré par la plateforme, pas déclaré par eux. Je les classe par la solidité de leur historique (borne basse de leur taux de réussite), pas par leurs gains bruts. Attention : parmi ${S.autres?.n_classes || 'des milliers de'} parieurs classés, le meilleur a forcément l'air brillant par pur hasard. Il faut un score z d'au moins ${S.autres?.seuil_chance ?? '3,8'} pour dépasser la chance. Je suis aussi leurs paris ici pour vérifier moi-même.</p>
    ${(S.autres?.paris||[]).length ? `<div class="picks">${S.autres.paris.map(a=>`<article class="pick"><div class="top"><div class="who"><b>${esc(a.pari)}</b> <span class="sub">${esc(a.match)}</span></div>${a.notre!=null?`<span class="big">${pct(a.notre)}</span>`:''}</div>
      <div class="chips"><span class="chip">Parieur : ${esc(a.parieur.nom)}</span><span class="chip">${esc(a.parieur.record)} (${pct(a.parieur.taux)})</span>${a.parieur.au_dela_chance?'<span class="chip good">Au-delà de la chance</span>':'<span class="chip warn">Peut être de la chance</span>'}${a.notre!=null?(a.notre>=0.5?'<span class="chip good">Je suis d’accord</span>':'<span class="chip bad">Je ne suis pas d’accord</span>'):''}</div>
      <ul><li>${esc(a.avis)}</li><li>Historique : ${a.parieur.record}, réussite ${pct(a.parieur.taux)}, au minimum ${pct(a.parieur.borne_basse)} avec 95 % de confiance (score z ${a.parieur.z}).</li>${a.ev!=null?`<li>Espérance à cette cote selon moi : ${a.ev>0?'+':''}${Math.round(a.ev*100)} %.</li>`:''}</ul>
      <a class="sub" href="${esc(a.parieur.url)}" target="_blank" rel="noopener">Voir son profil Covers</a></article>`).join('')}</div>` : '<div class="empty">Les meilleurs parieurs n’ont pas encore publié leurs paris de ce soir.</div>'}
    <h2>Accord avec les autres parieurs</h2>"""
s = s.replace(old, new, 1)
open(P, 'w', encoding='utf-8').write(s)
print('ok')
