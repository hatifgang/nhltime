// OLBG.com (communauté de pronostiqueurs britannique) : pour chaque match, la part des tipsters sur chaque choix
// et le pari du meilleur tipster, avec ses résultats enregistrés par la plateforme sur 12 mois (mise de 10 points).
// Comme pour Covers, c'est un indice À VÉRIFIER : on note nous-mêmes chacun de ces paris pour mesurer leur vraie valeur.
import { norm, pool } from './util.mts';

// Budget de temps strict : OLBG répond lentement aux serveurs Netlify, et l'analyse automatique doit rester sous 30 s.
const BUDGET_MS = 8000;
async function getT(url: string, ms: number) {
  if (ms < 500) return null;
  try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (nhl-paris)' }, redirect: 'follow', signal: AbortSignal.timeout(ms) }); return r.ok ? await r.text() : null; } catch { return null; }
}

const BASE = 'https://www.olbg.com/betting-tips';
const LIST = { nhl: `${BASE}/Ice_Hockey/13`, nba: `${BASE}/Basketball/4` };

function toLines(html: string) {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&rsquo;|&#39;|&#x27;/g, "'").replace(/&quot;/g, '"')
    .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
export interface OlbgLeg { kind: 'win' | 'spread' | 'over' | 'under'; team?: string; line?: number }
export interface OlbgTip { tipster: string; date: string; market: string; selection: string; profit: number | null; strike: number | null; p30: number | null; p7: number | null; leg: OlbgLeg | null }
export interface OlbgGame { ext: string; dom: string; url: string; consensus: { market: string; selection: string; n: number; total: number; pct: number; leg: OlbgLeg | null }[]; best: OlbgTip | null; tips: OlbgTip[] }

/** nick : abréviation -> surnom d'équipe (« Maple Leafs », « Knicks »…). */
export async function fetchOlbg(league: 'nhl' | 'nba', games: { ext: string; dom: string }[], nick: Record<string, string>) {
  const t0 = Date.now(), left = () => BUDGET_MS - (Date.now() - t0);
  const list = await getT(LIST[league], Math.min(4500, left()));
  if (!list) return { ok: false, reason: 'olbg.com inaccessible', games: [] as OlbgGame[] };
  const lastWord = (s: string) => { const p = norm(s).split(' '); return p[p.length - 1]; };
  const teamOf = (side: string) => { const n = norm(side.replace(/_/g, ' ')); return Object.keys(nick).find(ab => n.endsWith(lastWord(nick[ab]))) || null; };
  const lg = league.toUpperCase();
  const links = [...new Set([...list.matchAll(new RegExp(`href="(https://www\\.olbg\\.com/betting-tips/[A-Za-z_]+/${lg}/${lg}/([^"/]+)/\\d+\\?event_id=\\d+)"`, 'g'))].map(m => m[1] + '|' + m[2]))];
  const wanted = links.map(s => { const [url, title] = s.split('|'); const [a, h] = title.split('_@_'); return { url, ext: a ? teamOf(a) : null, dom: h ? teamOf(h) : null }; })
    .filter(x => x.ext && x.dom && games.some(g => g.ext === x.ext && g.dom === x.dom));
  const out = (await pool(wanted, 8, async w => {
    const html = await getT(w.url, left());
    if (!html) return null;
    const L = toLines(html);
    const legOf = (market: string, sel: string): OlbgLeg | null => {
      const m = market.toLowerCase();
      const ou = sel.match(/^(Over|Under) ([\d.]+)/i);
      if (ou && /total/.test(m)) return { kind: ou[1].toLowerCase() as any, line: +ou[2] };
      const team = teamOf(sel.replace(/ [+-]?[\d.]+$/, ''));
      if (!team) return null;
      if (/money ?line|match betting|winner/.test(m)) return { kind: 'win', team };
      const sp = sel.match(/([+-][\d.]+)$/);
      if (sp && /puck line|handicap|spread/.test(m)) return { kind: 'spread', team, line: +sp[1] };
      return null;
    };
    const consensus: OlbgGame['consensus'] = [];
    let market = '';
    const tips: OlbgTip[] = [];
    let curSel = '', curMarket = '';
    for (let i = 0; i < L.length; i++) {
      if (L[i + 1] === 'Hide Selections') market = L[i];
      const wt = L[i].match(/^(\d+) \/ (\d+) Win Tips$/);
      if (wt && market) { curSel = L[i - 1]; curMarket = market; if (!consensus.some(c => c.market === market && c.selection === curSel)) consensus.push({ market, selection: curSel, n: +wt[1], total: +wt[2], pct: +wt[1] / +wt[2], leg: legOf(market, curSel) }); }
      if (/^Best Tipster/.test(L[i])) { curSel = L[i + 1]; curMarket = L[i + 2]; }
      if (L[i] === 'Annual Profit') {
        // en remontant : la ligne de date, précédée du pseudo du tipster
        let d = i - 1; while (d > i - 12 && !/^[A-Z][a-z]{2} \d{1,2}(st|nd|rd|th), \d{4}/.test(L[d])) d--;
        const num = (k: string) => { const j = L.indexOf(k, i); return j > 0 && j < i + 12 ? parseFloat(L[j + 1]) : null; };
        if (d > i - 12) tips.push({ tipster: L[d - 1], date: L[d], market: curMarket, selection: curSel, profit: parseFloat(L[i + 1]), strike: num('Annual Strike Rate'), p30: num('30 Days Profit'), p7: num('7 Days Profit'), leg: legOf(curMarket, curSel) });
      }
    }
    const seen = new Set<string>();
    const uniq = tips.filter(t => { const k = t.tipster + '|' + t.selection; if (seen.has(k)) return false; seen.add(k); return true; });
    // meilleur tipster du match : le plus rentable sur 12 mois (c'est aussi le critère d'OLBG)
    const best = [...uniq].filter(t => t.leg).sort((a, b) => (b.profit ?? -1e9) - (a.profit ?? -1e9))[0] || null;
    return { ext: w.ext!, dom: w.dom!, url: w.url, consensus, best, tips: uniq } as OlbgGame;
  })).filter(Boolean) as OlbgGame[];
  const manq = wanted.length - out.length;
  return { ok: out.length > 0, reason: out.length ? (manq ? `${manq} match(s) trop lent(s) à charger` : '') : (wanted.length ? 'olbg.com trop lent ce soir' : 'aucun match du soir trouvé sur olbg.com'), games: out };
}

/** Lecture humaine d'une jambe OLBG. */
export const legLabel = (l: OlbgLeg | null, sel: string, unit: string) => !l ? sel : l.kind === 'win' ? `${l.team} gagne` : l.kind === 'spread' ? `${l.team} ${l.line! > 0 ? '+' : ''}${l.line} (handicap)` : `${l.kind === 'over' ? 'Plus' : 'Moins'} de ${l.line} ${unit}`;
