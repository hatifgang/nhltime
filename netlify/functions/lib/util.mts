// Outils communs : accès réseau aux sources nhl.com, dates (heure de l'Est / Paris), noms.
export const W = 'https://api-web.nhle.com/v1';
export const S = 'https://api.nhle.com/stats/rest/en';

let cache = new Map<string, Promise<any>>();
export const resetCache = () => { cache = new Map(); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchRetry(url: string, kind: 'json' | 'text'): Promise<any> {
  let err: any;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (nhl-paris)' }, redirect: 'follow', signal: AbortSignal.timeout(9000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return kind === 'json' ? await r.json() : await r.text();
    } catch (e) { err = e; await sleep(250 * (i + 1)); }
  }
  throw new Error(`${url} : ${err}`);
}

export function get(url: string): Promise<any> {
  if (!cache.has(url)) {
    const p = fetchRetry(url, 'json');
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return cache.get(url)!;
}
export async function safe<T = any>(url: string, def: T): Promise<T> {
  try { return await get(url); } catch (e) { console.log('! ' + e); return def; }
}
export async function getText(url: string): Promise<string | null> {
  try { return await fetchRetry(url, 'text'); } catch (e) { console.log('! ' + e); return null; }
}
export async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export const nm = (x: any): string => (x && typeof x === 'object') ? (x.default ?? Object.values(x)[0] ?? '') : (x ?? '');
export const r3 = (x: any, n = 3) => (x == null || !isFinite(x)) ? null : Math.round(x * 10 ** n) / 10 ** n;
export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export function norm(s: string) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
/** Vrai si le nom complet `full` correspond au texte (nom de famille + initiale si présente). */
export function nameMatch(full: string, text: string) {
  const f = norm(full), t = norm(text);
  if (!f || !t) return false;
  if (f === t) return true;
  const fp = f.split(' '), tp = t.split(' ');
  const last = fp[fp.length - 1];
  if (!tp.includes(last)) return false;
  return tp.length === 1 || fp[0][0] === tp[0][0];
}

export function etDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function parisStamp(d = new Date()) {
  const s = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
  return s.replace(',', '') + ' (Paris)';
}
export function parisHM(iso: string) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)).replace(',', '');
}
export function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}
export function seasons(iso: string): [string, string] {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  const start = m >= 8 ? y : y - 1;
  return [`${start}${start + 1}`, `${start - 1}${start}`];
}
export const americanToDecimal = (v: number) => v == null ? null : (v > 0 ? 1 + v / 100 : 1 + 100 / -v);
export const logit = (p: number) => Math.log(p / (1 - p));
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export function poisson(k: number, lam: number) {
  let f = 1; for (let i = 2; i <= k; i++) f *= i;
  return Math.exp(-lam) * lam ** k / f;
}
