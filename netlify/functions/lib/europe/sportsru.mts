// Page match sports.ru (KHL) : vote des internautes « Qui va gagner ? » et cotes du bookmaker partenaire.
// L'état de la page est écrit sous forme compacte « (function(a,b,…){return {…}}(valeurs)) » : on le DÉCODE
// comme du texte (lecteur de littéraux maison), sans jamais exécuter de code venant du site.

type Ref = { __ref: string };
const isRef = (v: any): v is Ref => v && typeof v === 'object' && typeof v.__ref === 'string' && Object.keys(v).length === 1;

class Reader {
  i = 0; s: string;
  constructor(s: string) { this.s = s; }
  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  peek() { this.ws(); return this.s[this.i]; }
  expect(c: string) { this.ws(); if (this.s[this.i] !== c) throw new Error(`attendu ${c} à ${this.i}`); this.i++; }
  ident() { this.ws(); const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 64)); if (!m) throw new Error(`identifiant attendu à ${this.i}`); this.i += m[0].length; return m[0]; }
  str() {
    const q = this.s[this.i++]; let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i++];
      if (c === q) return out;
      if (c !== '\\') { out += c; continue; }
      const e = this.s[this.i++];
      if (e === 'u') { if (this.s[this.i] === '{') { const j = this.s.indexOf('}', this.i); out += String.fromCodePoint(parseInt(this.s.slice(this.i + 1, j), 16)); this.i = j + 1; } else { out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16)); this.i += 4; } }
      else if (e === 'x') { out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 2), 16)); this.i += 2; }
      else out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' } as any)[e] ?? e;
    }
    throw new Error('chaîne non terminée');
  }
  value(): any {
    const c = this.peek();
    if (c === '{') {
      this.i++; const o: any = {};
      for (;;) {
        if (this.peek() === '}') { this.i++; return o; }
        const k = this.peek() === '"' || this.peek() === "'" ? this.str() : /[\d]/.test(this.peek()) ? String(this.num()) : this.ident();
        if (this.peek() === '[') throw new Error('clé calculée');
        this.expect(':'); o[k] = this.value();
        if (this.peek() === ',') this.i++;
      }
    }
    if (c === '[') {
      this.i++; const a: any[] = [];
      for (;;) { if (this.peek() === ']') { this.i++; return a; } a.push(this.value()); if (this.peek() === ',') this.i++; }
    }
    if (c === '"' || c === "'") return this.str();
    if (c === '-' || c === '.' || /\d/.test(c)) return this.num();
    const id = this.ident();
    if (id === 'true') return true; if (id === 'false') return false; if (id === 'null' || id === 'undefined') return null;
    if (id === 'void') { this.value(); return null; }
    if (id === 'NaN') return NaN; if (id === 'Infinity') return Infinity;
    if (this.peek() === '(' || this.peek() === '.') throw new Error(`appel non pris en charge (${id})`);
    return { __ref: id } as Ref;
  }
  num() { this.ws(); const m = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(this.s.slice(this.i, this.i + 40)); if (!m) throw new Error(`nombre attendu à ${this.i}`); this.i += m[0].length; return +m[0]; }
}

/** Décode tous les blocs « __vue_query » d'une page sports.ru (un par widget) et réunit leurs requêtes. */
export function decodeVueQuery(html: string): any | null {
  const KEY = "['__vue_query']:", queries: any[] = [];
  for (let k = html.indexOf(KEY); k >= 0; k = html.indexOf(KEY, k + KEY.length)) {
    try {
      const R = new Reader(html); R.i = k + KEY.length;
      R.expect('('); if (R.ident() !== 'function') continue;
      R.expect('('); const params: string[] = [];
      while (R.peek() !== ')') { params.push(R.ident()); if (R.peek() === ',') R.i++; }
      R.i++; R.expect('{'); if (R.ident() !== 'return') continue;
      const body = R.value();
      R.expect('}'); R.expect('(');
      const args: any[] = [];
      while (R.peek() !== ')') { args.push(R.value()); if (R.peek() === ',') R.i++; }
      const env: Record<string, any> = {}; params.forEach((p, i) => env[p] = i < args.length ? args[i] : null);
      const fix = (v: any): any => isRef(v) ? (v.__ref in env ? env[v.__ref] : null) : Array.isArray(v) ? v.map(fix) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([a, b]) => [a, fix(b)])) : v;
      queries.push(...(fix(body)?.queries || []));
    } catch { /* bloc illisible : ignoré */ }
  }
  return queries.length ? { queries } : null;
}

export interface KhlCrowd { votes: number; dom: number; nul: number; ext: number }   // parts 0..1
export interface KhlOdds { books: string[]; c1?: number; cX?: number; c2?: number; c1X?: number; cX2?: number; bttsOui?: number; bttsNon?: number; totals: { line: number; over?: number; under?: number }[] }

const r2 = (x: any) => typeof x === 'number' && isFinite(x) && x > 1 ? Math.round(x * 100) / 100 : undefined;
/** Lecture du vote et des cotes à partir de l'état décodé. */
export function readMatch(state: any): { crowd: KhlCrowd | null; odds: KhlOdds | null } {
  const qs: any[] = state?.queries || [];
  const q = (name: string) => qs.find(x => Array.isArray(x.queryKey) && x.queryKey[0] === name)?.state?.data;
  let crowd: KhlCrowd | null = null;
  const poll = q('match-poll');
  if (poll && poll.allVotes > 0) {
    const f = +poll.firstTeam?.votes || 0, s = +poll.secondTeam?.votes || 0, d = Math.max(0, +poll.allVotes - f - s);
    crowd = { votes: +poll.allVotes, dom: f / poll.allVotes, nul: d / poll.allVotes, ext: s / poll.allVotes };
  }
  let odds: KhlOdds | null = null;
  const lines: any[] = q('match-odds')?.lines || [];
  if (lines.length) {
    const o: KhlOdds = { books: [], totals: [] };
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
      if (Math.abs((imp(o.c1) + imp(o.cX)) / s1 - 1 / o.c1X) > 0.15) { o.c1 = o.cX = o.c2 = undefined; } }
    odds = o;
  }
  return { crowd, odds };
}

/** Cote du bookmaker pour un de nos codes de pari (null si la page ne la donne pas). */
export function bookOdds(o: KhlOdds | null | undefined, code: string): number | null {
  if (!o) return null;
  const tot = (line: number, side: 'over' | 'under') => o.totals.find(t => t.line === line)?.[side] ?? null;
  switch (code) {
    case '1': return o.c1 ?? null; case '2': return o.c2 ?? null; case '1X': return o.c1X ?? null; case 'X2': return o.cX2 ?? null;
    case 'btts': return o.bttsOui ?? null; case 'nbtts': return o.bttsNon ?? null;
    case 'o45': return tot(4.5, 'over'); case 'u45': return tot(4.5, 'under'); case 'o55': return tot(5.5, 'over'); case 'u55': return tot(5.5, 'under');
  }
  return null;
}

/** Page match sports.ru d'après son adresse. */
export async function khlMatchExtras(url: string, ms: number) {
  if (ms < 500) return null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (nhl-paris)' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const html = await r.text(), st = decodeVueQuery(html);
    if (!st) return null;
    // première équipe du sondage (normalement l'équipe à domicile) : sert à vérifier le sens des données
    const first = (html.match(/poll-variant__name"[^>]*>([^<]+)</) || [])[1]?.trim() || null;
    return { ...readMatch(st), first };
  } catch { return null; }
}
