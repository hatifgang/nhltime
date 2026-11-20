p='netlify/functions/lib/europe/sportsru.mts'
s=open(p,encoding='utf8').read()
a=s.index("    const o: KhlOdds = { books: [], totals: [] };")
b=s.index("    odds = o;")
new='''    const o: KhlOdds = { books: [], totals: [] };
    // plusieurs bookmakers par marché : on garde la cote MÉDIANE (un bookmaker affiche parfois une cote périmée)
    const med = (xs: any[]) => { const v = xs.filter(x => typeof x === 'number' && isFinite(x) && x > 1).sort((p, q) => p - q); return v.length ? r2(v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : undefined; };
    const items = (v: any) => (v?.items || []) as any[];
    const book = (its: any[]) => { for (const it of its) { const n = it?.bookmaker?.name; if (n && !o.books.includes(n)) o.books.push(n); } };
    for (const ln of lines) {
      const v = ln.view || {}, its = items(v);
      const f = (key: string, fld: string) => med(its.map(it => it?.[key]?.[fld]));
      if (its.some(it => it?.line1x2)) { book(its); o.c1 = f('line1x2', 'h'); o.cX = f('line1x2', 'x'); o.c2 = f('line1x2', 'a'); }
      if (its.some(it => it?.lineDoubleChance)) { book(its); o.c1X = f('lineDoubleChance', 'hx'); o.cX2 = f('lineDoubleChance', 'xa'); }
      if (its.some(it => it?.lineBothToScore)) { book(its); o.bttsOui = f('lineBothToScore', 'yesFactor'); o.bttsNon = f('lineBothToScore', 'noFactor'); }
      if (v.__typename === 'OddsTotalView') for (const bl of v.blocks || []) {
        const bi = items(bl);
        if (typeof bl.totalValue === 'number' && bi.some(it => it?.lineTotal)) { book(bi); o.totals.push({ line: bl.totalValue, over: med(bi.map(it => it?.lineTotal?.gt)), under: med(bi.map(it => it?.lineTotal?.lt)) }); }
      }
    }
    // contrôle de cohérence : 1X2 et double chance doivent raconter la même histoire, sinon on écarte le 1X2
    if (o.c1 && o.c2 && o.c1X && o.cX2) { const imp = (c?: number) => c ? 1 / c : 0; const s1 = imp(o.c1) + imp(o.cX) + imp(o.c2);
      if (Math.abs((imp(o.c1) + imp(o.cX)) / s1 - 1 / o.c1X / (1 / o.c1X + 1 / o.cX2) * 1) > 0.25) { o.c1 = o.cX = o.c2 = undefined; } }
'''
s=s[:a]+new+s[b:]
open(p,'w',encoding='utf8').write(s)
print('ok')
