// Lecture de l'article quotidien nhl.com « Projected lineups, starting goalies for today ».
// Seules les informations écrites dans l'article sont reprises ; rien n'est déduit au-delà.
import { getText, norm, nameMatch } from './util.mts';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const INJ_FR: Record<string, string> = {
  'upper body': 'haut du corps', 'lower body': 'bas du corps', 'undisclosed': 'non précisée', 'illness': 'maladie',
  'concussion': 'commotion', 'knee': 'genou', 'shoulder': 'épaule', 'hand': 'main', 'ankle': 'cheville', 'foot': 'pied',
  'hip': 'hanche', 'back': 'dos', 'groin': 'aine', 'wrist': 'poignet', 'leg': 'jambe', 'head': 'tête', 'neck': 'cou',
  'personal': 'raisons personnelles', 'not injury related': 'hors blessure',
};
const fr = (s: string) => INJ_FR[norm(s)] ? `${INJ_FR[norm(s)]} (${s})` : s;

function decode(s: string) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function splitList(s: string) {
  return s.split(/,(?![^()]*\))/).map(x => x.trim()).filter(Boolean);
}

export interface TeamLineup { lines: string[]; pairs: string[]; goalies: string[]; scratched: string[]; injured: { player: string; detail: string }[]; suspended: string[] }
export interface GameLineup { away: TeamLineup; home: TeamLineup; statusReport: string[]; uncertain: { player: string; team: string; detail: string }[]; confirmedGoalies: string[] }

export function articleUrl(season: string) {
  return `https://www.nhl.com/news/nhl-lineup-projections-${season.slice(0, 4)}-${season.slice(6)}-season`;
}

/** nickUpper : « RED WINGS » -> « DET ». Retourne null si l'article n'est pas celui du jour. */
const strip = (b: any): TeamLineup => ({ lines: b.lines, pairs: b.pairs, goalies: b.goalies, scratched: b.scratched, injured: b.injured, suspended: b.suspended });

export async function fetchLineups(dateIso: string, season: string, nickUpper: Record<string, string>, posOf?: (team: string, name: string) => 'F' | 'D' | 'G' | null) {
  const url = articleUrl(season);
  const html = await getText(url);
  if (!html) return { ok: false, reason: 'article nhl.com inaccessible', url, games: {} as Record<string, GameLineup> };
  let t = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')
    .replace(/<(br|\/p|\/h\d|\/li|\/div|\/header|\/section)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '');
  const lines = decode(t).split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const [y, m, d] = dateIso.split('-').map(Number);
  const wanted = `${MONTHS[m - 1]} ${String(d).padStart(2, '0')}, ${y}`;
  const dateLine = lines.find(l => /^[A-Z][a-z]+ \d{2}, \d{4}$/.test(l));
  if (!dateLine || dateLine.toLowerCase() !== wanted) {
    return { ok: false, reason: `article nhl.com pas encore publié pour ce jour (dernier : ${dateLine || 'inconnu'})`, url, games: {} };
  }
  const games: Record<string, GameLineup> = {};
  // Variantes vues sur nhl.com : « X at Y », « X Y » (sans « at »), « projected lineup » ou « projected lines ».
  const header = /^([A-Z][A-Z .'’-]+?) \(\d+-\d+-\d+\)\s+(?:at\s+|vs\.?\s+|@\s+)?([A-Z][A-Z .'’-]+?) \(\d+-\d+-\d+\)$/;
  const blockHead = /^(.+?) projected (?:lineup|lines|line combinations?)\b/i;
  const teamOfNick = (txt: string) => { const u = txt.toUpperCase().trim(); return nickUpper[u] || Object.entries(nickUpper).find(([k]) => u.endsWith(k) || k.endsWith(u))?.[1] || null; };
  let i = 0;
  while (i < lines.length) {
    const h = lines[i].match(header);
    if (!h) { i++; continue; }
    const away = nickUpper[h[1].trim()], home = nickUpper[h[2].trim()];
    i++;
    const blocks: (TeamLineup & { team: string | null; rows: string[] })[] = [];
    const status: string[] = [];
    let mode: 'team' | 'status' | null = null;
    let cur: any = null;
    while (i < lines.length && !header.test(lines[i])) {
      const l = lines[i];
      const bh = l.match(blockHead);
      if (bh) {
        cur = { team: teamOfNick(bh[1]), rows: [], lines: [], pairs: [], goalies: [], scratched: [], injured: [], suspended: [] };
        blocks.push(cur); mode = 'team';
      } else if (/^status report$/i.test(l)) { mode = 'status'; }
      else if (mode === 'team' && cur) {
        const lab = l.match(/^(Scratched|Injured|Suspended|Out|Day-to-day|Day to day)\s*:\s*(.*)$/i);
        if (lab) {
          const items = splitList(lab[2]);
          const k = lab[1].toLowerCase();
          if (k === 'scratched') cur.scratched.push(...items);
          else if (k === 'suspended') cur.suspended.push(...items);
          else cur.injured.push(...items.map(x => { const mm = x.match(/^(.*?)\s*\((.*)\)$/); return mm ? { player: mm[1].trim(), detail: fr(mm[2].trim()) } : { player: x, detail: 'non précisée' }; }));
        } else if (l.includes(' -- ') || (/^[A-ZÀ-Ý][\p{L}.'’ -]+$/u.test(l) && l.split(' ').length <= 4 && !/fantasy|nhl\.com|^by$/i.test(l))) {
          cur.rows.push(l);
        }
      } else if (mode === 'status') {
        if (/^(FANTASY|Top 200|Related|More|Latest)/i.test(l)) { mode = null; } else status.push(l);
      }
      i++;
    }
    // Attribution des blocs par le nom d'équipe écrit dans l'en-tête du bloc (l'ordre peut être trompeur)
    const bAway = blocks.find(b => b.team === away) || blocks.find(b => !b.team && b !== blocks.find(x => x.team === home)) || null;
    const bHome = blocks.find(b => b.team === home) || blocks.find(b => b !== bAway && (!b.team || b.team === home)) || null;
    // Classement de chaque rangée par la position officielle des joueurs (effectif nhl.com), puis par forme du texte
    for (const [ab, b] of [[away, bAway], [home, bHome]] as const) {
      if (!b) continue;
      for (const row of b.rows) {
        const names = row.split(' -- ').map(x => x.trim()).filter(Boolean);
        const pos = names.map(n => posOf ? posOf(ab, n) : null);
        const known = pos.filter(Boolean).length;
        if (known && pos.every(x => x === 'G' || x == null) && pos.includes('G')) { b.goalies.push(...names); continue; }
        if (known) { (pos.filter(x => x === 'D').length * 2 >= names.length ? b.pairs : b.lines).push(names.join(' -- ')); continue; }
        if (names.length >= 3) b.lines.push(names.join(' -- '));
        else if (names.length === 2) (b.lines.length >= 4 ? b.pairs : b.lines).push(names.join(' -- '));
        else if (b.lines.length >= 3 && b.pairs.length >= 2) b.goalies.push(names[0]);
      }
    }
    if (away && home && bAway && bHome) {
      const sentences = status.join(' ').split(/(?<=[.!?…])\s+/).filter(Boolean);
      const uncertain: GameLineup['uncertain'] = [];
      const confirmedGoalies: string[] = [];
      const everyone: { name: string; team: string }[] = [];
      for (const [k, b] of [[away, bAway], [home, bHome]] as [string, TeamLineup][]) {
        for (const ln of [...b.lines, ...b.pairs]) for (const p of ln.split(' -- ')) everyone.push({ name: p, team: k });
        for (const p of [...b.goalies, ...b.scratched, ...b.injured.map(x => x.player)]) everyone.push({ name: p, team: k });
      }
      for (const s of sentences) {
        const who = everyone.filter(p => norm(s).split(' ').includes(norm(p.name).split(' ').slice(-1)[0]));
        if (/game-time decision|day-to-day|day to day|questionable|is uncertain|will be evaluated|could return|may return|status is unclear/i.test(s)) {
          for (const p of who) if (!uncertain.some(u => u.player === p.name)) uncertain.push({ player: p.name, team: p.team, detail: s });
        }
        if (/will start|gets the start|is expected to start|confirmed (as the )?starter|will be in goal|starts in goal/i.test(s)) {
          for (const p of who) confirmedGoalies.push(p.name);
        }
      }
      games[`${away}@${home}`] = { away: strip(bAway), home: strip(bHome), statusReport: sentences, uncertain, confirmedGoalies };
    }
  }
  return { ok: Object.keys(games).length > 0, reason: Object.keys(games).length ? '' : 'format de l’article non reconnu', url, games };
}

export function isInLineup(tl: TeamLineup | undefined, name: string) {
  if (!tl) return false;
  return [...tl.lines, ...tl.pairs].some(l => l.split(' -- ').some(p => nameMatch(name, p)));
}
export function lineSlot(tl: TeamLineup | undefined, name: string) {
  if (!tl) return null;
  const f = tl.lines.findIndex(l => l.split(' -- ').some(p => nameMatch(name, p)));
  if (f >= 0) return `L${f + 1}`;
  const d = tl.pairs.findIndex(l => l.split(' -- ').some(p => nameMatch(name, p)));
  return d >= 0 ? `P${d + 1}` : null;
}
