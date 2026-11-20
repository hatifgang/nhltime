B = 'netlify/functions/lib/pipeline.mts'
s = open(B, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, old[:90]
    s = s.replace(old, new, 1)


# les buteurs de chaque match doivent être disponibles comme jambes (pas seulement ceux à 35 % et plus)
rep("    if (p.p_but >= 0.35) legs.push({ ...base, kind: 'but',",
    "    if (p.p_but >= 0.25) legs.push({ ...base, kind: 'but',")
rep("  const fun = [funSearch(5, 3), funSearch(10, 4)].filter(Boolean);   // moins de jambes = moins de marge et d'erreurs cumulées",
    """  // Paris fun à thème (demandé après 1 gagnant sur 27) : au plus UN pari sur le total de buts,
  // un seul pari par match, jambes « joueur » décotées de 5 % (erreur du modèle), meilleure espérance pour la cote visée.
  const themed = (theme: string, target: number, quota: Record<string, [number, number]>, minLegs: number, maxLegs: number) => {
    const kinds = Object.keys(quota);
    const pool = legs.filter(l => kinds.includes(l.kind) && l.prob >= 0.2).map(l => l.marche ? l : { ...l, prob: l.prob * 0.95 })
      .sort((x, y) => (y.prob * y.cote) - (x.prob * x.cote) || y.prob - x.prob).slice(0, 40);
    let best: any = null;
    const count = (c: any[], k: string) => c.filter(x => x.kind === k).length;
    const ok = (c: any[]) => kinds.every(k => count(c, k) >= quota[k][0]);
    const score = (c: any) => c.prob * c.cote - 0.03 * c.legs.length;
    const rec = (start: number, chosen: any[], prob: number, cote: number) => {
      if (chosen.length >= minLegs && cote >= target && ok(chosen)) {
        const c = { legs: [...chosen], prob, cote };
        if (cote <= target * 2.5 && (!best || score(c) > score(best))) best = c;
      }
      if (chosen.length === maxLegs) return;
      for (let i = start; i < pool.length; i++) {
        const l = pool[i];
        if (chosen.some(c => c.game_id === l.game_id)) continue;
        if (count(chosen, l.kind) >= quota[l.kind][1]) continue;
        chosen.push(l); rec(i + 1, chosen, prob * l.prob, cote * l.cote); chosen.pop();
      }
    };
    rec(0, [], 1, 1);
    return best ? { theme, cible: target, prob: r3(best.prob, 3), cote: r3(best.cote, 2), cote_juste: r3(1 / best.prob, 2),
      legs: best.legs.map((l: any) => ({ kind: l.kind, team: l.team, line: l.line, player_id: l.player_id, game_id: l.game_id, label: l.label, match: l.match, prob: l.prob, cote: l.cote, marche: l.marche })) } : null;
  };
  const fun = [
    themed('Buteurs', 5, { but: [2, 4] }, 2, 4),
    themed('Victoire + buteur', 5, { win: [1, 3], but: [1, 1] }, 2, 4),
    themed('Mélange', 6, { point: [1, 1], but: [1, 1], win: [1, 1], over: [0, 1], under: [0, 1] }, 3, 4),
  ].filter(Boolean) as any[];
  for (const f of fun) if (f.legs.filter((l: any) => l.kind === 'over' || l.kind === 'under').length > 1) f.legs = f.legs;  // garde-fou : quotas déjà limités à 1 total""")
rep("type: `Pari fun ${f.cible}+`,", "type: `Pari fun ${f.theme}`,")
rep("'Pari fun 5+', 'Pari fun 10+', 'Pari parieur Covers', 'Buteur du soir'].map(typ => {",
    "'Pari fun 5+', 'Pari fun 10+', 'Pari fun Buteurs', 'Pari fun Victoire + buteur', 'Pari fun Mélange', 'Pari parieur Covers', 'Buteur du soir'].map(typ => {")
s = s.replace("  for (const f of fun) if (f.legs.filter((l: any) => l.kind === 'over' || l.kind === 'under').length > 1) f.legs = f.legs;  // garde-fou : quotas déjà limités à 1 total\n", "")
open(B, 'w', encoding='utf-8').write(s)

# total : au plus un « plus » OU un « moins » dans le mélange -> quotas séparés over/under à 1 chacun ; on interdit les deux
s = open(B, encoding='utf-8').read()
old = "    const ok = (c: any[]) => kinds.every(k => count(c, k) >= quota[k][0]);"
assert old in s
s = s.replace(old, "    const ok = (c: any[]) => kinds.every(k => count(c, k) >= quota[k][0]) && count(c, 'over') + count(c, 'under') <= 1;")
old = "        if (count(chosen, l.kind) >= quota[l.kind][1]) continue;"
s = s.replace(old, "        if (count(chosen, l.kind) >= quota[l.kind][1]) continue;\n        if ((l.kind === 'over' || l.kind === 'under') && count(chosen, 'over') + count(chosen, 'under') >= 1) continue;")
open(B, 'w', encoding='utf-8').write(s)

P = 'public/index.html'
s = open(P, encoding='utf-8').read()
rep("<b>Cote ${f.cible}+ : ${f.cote}</b> <span class=\"sub\">${f.legs.length} paris combinés</span>",
    "<b>${esc(f.theme || ('Cote '+f.cible+'+'))} : cote ${f.cote}</b> <span class=\"sub\">${f.legs.length} paris combinés</span>")
rep("<p class=\"lead\">Pour le plaisir et le risque assumé. Je cherche la combinaison qui a le plus de chances d'atteindre la cote visée, avec un seul pari par match.",
    "<p class=\"lead\">Pour le plaisir et le risque assumé. Trois paris à thème : des buteurs, des victoires avec un buteur, et un mélange (point, buteur, victoire, au plus un total de buts). Un seul pari par match.")
open(P, 'w', encoding='utf-8').write(s)
print('ok')
