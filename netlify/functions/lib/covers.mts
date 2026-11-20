// Covers.com (depuis 1995) : pourcentage du public par équipe et choix des « Team Money Leaders »,
// les joueurs des concours Covers qui gagnent le plus sur une équipe donnée. Leurs résultats sont enregistrés
// par la plateforme (pas déclarés par eux-mêmes). Nous les traitons comme un indice À VÉRIFIER : chaque soir on
// enregistre leurs choix et on mesure nous-mêmes s'ils gagnent vraiment, avant de leur accorder du poids.
import { getText, norm, pool } from './util.mts';

const BASE = 'https://contests.covers.com';

function toText(html: string) {
  const t = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"');
  return t.split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

export interface CoversGame {
  away: string; home: string;               // abréviations NHL
  public_ext: number; public_dom: number;   // % des choix du public (vainqueur)
  over_pct: number | null; total: number | null;
  leaders_ext: number; leaders_dom: number; // nombre de choix des Team Money Leaders
  leaders_over: number; leaders_under: number;
  url: string;
}

/** placeToAbbr : « san jose » -> « SJS » (noms de ville nhl.com normalisés). */
export async function fetchCovers(placeToAbbr: Record<string, string>, league: 'nhl' | 'nba' = 'nhl') {
  const list = await getText(`${BASE}/consensus/topconsensus/${league}/overall`);
  if (!list) return { ok: false, reason: 'covers.com inaccessible', games: [] as CoversGame[] };
  const links = [...new Set([...list.matchAll(/href="(\/consensus\/matchupconsensusdetails\/[0-9a-f-]{36})"/g)].map(m => m[1]))];
  const find = (name: string) => {
    const n = norm(name).replace(/^n y /, 'ny ').replace(/^new york /, 'ny ');
    return placeToAbbr[n] || Object.entries(placeToAbbr).find(([k]) => n.startsWith(k) || k.startsWith(n))?.[1] || null;
  };
  const games = (await pool(links.slice(0, 20), 6, async (path) => {
    const html = await getText(BASE + path);
    if (!html) return null;
    const title = html.match(/<title>\s*(?:NHL |NBA )?Picks - (.+?) vs (.+?) Consensus/i);
    if (!title) return null;
    const away = find(title[1]), home = find(title[2]);
    if (!away || !home) return null;
    const t = toText(html);
    const pk = t.match(/(?:Moneyline|ATS) Consensus: Picks Per Line\n(\d+) %\n[^\n]+\nPicks\n[^\n]+\n(\d+) %/);   // NBA : consensus sur le handicap (ATS)
    const ou = t.match(/(\d+) %\nOVER\nTOTAL\n(\d+) %\nUNDER\n\d+\n([\d.]+)/);
    const ld = t.match(/(?:Moneyline|ATS) Picks\n(\d+)\n(?:Moneyline|ATS) Picks\n(\d+)\nOver Picks\n(\d+)\nUnder Picks\n(\d+)/);
    if (!pk) return null;
    return {
      away, home, public_ext: +pk[1], public_dom: +pk[2],
      over_pct: ou ? +ou[1] : null, total: ou ? +ou[3] : null,
      leaders_ext: ld ? +ld[1] : 0, leaders_dom: ld ? +ld[2] : 0, leaders_over: ld ? +ld[3] : 0, leaders_under: ld ? +ld[4] : 0,
      url: BASE + path,
    } as CoversGame;
  })).filter(Boolean) as CoversGame[];
  return { ok: games.length > 0, reason: games.length ? '' : 'format Covers non reconnu', games };
}

// ---------------------------------------------------------------------------------------------
// Paris individuels des meilleurs parieurs Covers (historique enregistré par la plateforme).
// On les classe par la borne basse de Wilson de leur taux de réussite : un historique long et
// solide passe devant un petit échantillon flatteur.
export interface Bettor { nom: string; url: string; gagnes: number; perdus: number; taux: number; unites: number; borne_basse: number; z: number }
export interface BettorPick { parieur: Bettor; away: string; home: string; heure: string; pari: string; kind: 'win' | 'over' | 'under' | 'spread'; team: string | null; line: number | null; cote: number | null }

const wilsonLow = (w: number, n: number, z = 1.96) => {
  if (!n) return 0;
  const p = w / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
};
const amToDec = (v: number) => v > 0 ? 1 + v / 100 : 1 + 100 / -v;

export async function fetchTopBettors(placeToAbbr: Record<string, string>, maxProfiles = 10, league: 'nhl' | 'nba' = 'nhl') {
  const page = await getText(`${BASE}/consensus/pickleaders/${league}`);
  if (!page) return { ok: false, reason: 'classement Covers inaccessible', parieurs: [] as Bettor[], paris: [] as BettorPick[], n_classes: 0, seuil_chance: 0 };
  const rows = [...page.matchAll(/href="(https:\/\/contests\.covers\.com\/kingofcovers\/contestant\/[0-9a-f-]+)">\s*([^<]+?)\s*<\/a>[\s\S]*?<td[^>]*>\s*([+-]?\d+)\s*<\/td>\s*<td[^>]*>\s*(\d+)-(\d+)-\d+/g)];
  const bettors: Bettor[] = rows.map(m => {
    const w = +m[4], l = +m[5], n = w + l;
    return { nom: m[2].trim(), url: m[1], gagnes: w, perdus: l, taux: n ? w / n : 0, unites: +m[3], borne_basse: wilsonLow(w, n), z: n ? (w / n - 0.5) / Math.sqrt(0.25 / n) : 0 };
  }).filter(b => b.gagnes + b.perdus >= 40).sort((a, b) => b.borne_basse - a.borne_basse);
  const find = (name: string) => {
    const n = norm(name).replace(/^n y /, 'ny ').replace(/^new york /, 'ny ');
    return placeToAbbr[n] || Object.entries(placeToAbbr).find(([k]) => n.startsWith(k) || k.startsWith(n))?.[1] || null;
  };
  const picks: BettorPick[] = [];
  await pool(bettors.slice(0, maxProfiles), 5, async (b) => {
    const html = await getText(b.url);
    if (!html) return;
    const L = toText(html).split('\n');
    const i = L.indexOf('Pending Picks'), j = L.indexOf('Completed Picks');
    if (i < 0 || j < 0 || L[i + 1] === 'No pending picks.') return;
    const seg = L.slice(i + 1, j);
    const st = seg.indexOf('Status');
    for (let k = st + 1; k + 7 < seg.length; k += 8) {
      const [awayN, homeN, , , heure, pari] = seg.slice(k, k + 8);
      const away = find(awayN), home = find(homeN);
      if (!away || !home) continue;
      const ou = pari.match(/^(Over|Under) ([\d.]+)/i);
      const tm = pari.match(/^([A-Z]{2,4}) ([+-]\d+(?:\.\d+)?|PK)/);
      let team: string | null = null;
      if (tm) team = [away, home].find(a => a.startsWith(tm[1]) || a === tm[1]) || [away, home].find(a => a[0] === tm[1][0] && a[1] === tm[1][1]) || null;
      if (!ou && !team) continue;
      const v = tm ? (tm[2] === 'PK' ? 0 : +tm[2]) : null;
      const isSpread = v != null && Math.abs(v) < 60;   // NBA : « LAL +3.5 » est un handicap, pas une cote
      picks.push({ parieur: b, away, home, heure, pari, kind: ou ? (ou[1].toLowerCase() as any) : isSpread ? 'spread' : 'win', team, line: ou ? +ou[2] : isSpread ? v : null, cote: tm && !isSpread ? amToDec(v!) : null });
    }
  });
  // Seuil « au-delà de la chance » : le meilleur de N parieurs atteint naturellement un z d'environ racine(2 ln N).
  const pages = Math.max(1, ...[...page.matchAll(/pageNum=(\d+)/g)].map(m => +m[1]));
  const seuil = Math.sqrt(2 * Math.log(pages * 50));
  return { ok: bettors.length > 0, reason: '', parieurs: bettors.slice(0, 10), paris: picks, n_classes: pages * 50, seuil_chance: seuil };
}
