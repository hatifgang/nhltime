// Hockey européen : KHL (sports.ru, grand média sportif russe — khl.ru refuse les programmes automatiques),
// SHL suédoise (shl.se, site officiel) et Liiga finlandaise (liiga.fi, site officiel). Chaque match est ramené au même format.
import { norm } from '../util.mts';

export interface EGame { lg: 'KHL' | 'SHL' | 'Liiga'; id: string; date: string; utc: string | null; dom: string; ext: string; done: boolean;
  hs: number | null; as: number | null; fin: 'REG' | 'OT' | 'SO' | null; reg_h?: number | null; reg_a?: number | null }
export interface ERow { team: string; mj: number; v: number; vo: number; d: number; dp: number; bp: number; bc: number; pts: number }

const UA = { 'User-Agent': 'Mozilla/5.0 (nhl-paris)' };
async function txt(url: string, ms = 9000) { try { const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(ms) }); return r.ok ? await r.text() : null; } catch { return null; } }
async function js(url: string, ms = 9000) { try { const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; } }
const lines = (h: string) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

// ------------------------------------------------------------------ KHL (sports.ru)
export const KHL_FR: Record<string, string> = {
  'ЦСКА': 'CSKA Moscou', 'СКА': 'SKA Saint-Pétersbourg', 'Локомотив': 'Lokomotiv Iaroslavl', 'Динамо Москва': 'Dynamo Moscou', 'Спартак': 'Spartak Moscou', 'Торпедо': 'Torpedo Nijni Novgorod',
  'Северсталь': 'Severstal Tcherepovets', 'Динамо Минск': 'Dinamo Minsk', 'Шанхай Дрэгонс': 'Shanghai Dragons', 'Сочи': 'HK Sotchi', 'Ак Барс': 'Ak Bars Kazan', 'Металлург Мг': 'Metallurg Magnitogorsk',
  'Авангард': 'Avangard Omsk', 'Трактор': 'Traktor Tcheliabinsk', 'Салават Юлаев': 'Salavat Ioulaïev Oufa', 'Автомобилист': 'Avtomobilist Iekaterinbourg', 'Нефтехимик': 'Neftekhimik Nijnekamsk',
  'Сибирь': 'Sibir Novossibirsk', 'Барыс': 'Barys Astana', 'Адмирал': 'Admiral Vladivostok', 'Амур': 'Amour Khabarovsk', 'Лада': 'Lada Togliatti', 'Куньлунь': 'Kunlun Red Star', 'Витязь': 'Vitiaz Podolsk',
};
const MONTHS: Record<string, number> = { 'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4, 'мая': 5, 'июня': 6, 'июля': 7, 'августа': 8, 'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12 };
const kn = (s: string) => KHL_FR[s] || s;
/** Calendrier sports.ru : « 16 ноября [2026] | … | 17:00 | Хозяева | [б|от] | 3 | - | 2 | Гости ». Heure de Moscou (UTC+3). */
export function parseKhlCalendar(html: string, seasonStartYear: number): EGame[] {
  const L = lines(html), out: EGame[] = [];
  let date: string | null = null;
  for (let i = 0; i < L.length; i++) {
    const dm = L[i].match(/^(\d{1,2}) ([а-я]+)(?: (\d{4}))?$/);
    if (dm && MONTHS[dm[2]]) { const m = MONTHS[dm[2]]; const y = dm[3] ? +dm[3] : (m >= 8 ? seasonStartYear : seasonStartYear + 1); date = `${y}-${String(m).padStart(2, '0')}-${dm[1].padStart(2, '0')}`; continue; }
    if (!date || !/^\d{2}:\d{2}$/.test(L[i])) continue;
    let j = i + 1; const home = L[j++]; let mark: string | null = null;
    if (L[j] === 'б' || L[j] === 'от') mark = L[j++];
    const a = L[j], dash = L[j + 1], b = L[j + 2], away = L[j + 3];
    if (dash !== '-' || !home || !away || /^\d{2}:\d{2}$/.test(away)) continue;
    const done = /^\d+$/.test(a) && /^\d+$/.test(b);
    const [hh, mm] = L[i].split(':').map(Number);
    const utc = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hh - 3, mm)).toISOString();
    out.push({ lg: 'KHL', id: `KHL-${date}-${norm(kn(home))}-${norm(kn(away))}`.replace(/\s/g, '_'), date, utc, dom: kn(home), ext: kn(away), done, hs: done ? +a : null, as: done ? +b : null, fin: done ? (mark === 'б' ? 'SO' : mark === 'от' ? 'OT' : 'REG') : null });
    i = j + 3;
  }
  return out;
}
export function parseKhlTable(html: string): ERow[] {
  const L = lines(html), out: ERow[] = [];
  for (let i = 0; i < L.length; i++) {
    if (L[i] !== 'Команда' || L[i + 1] !== 'М') continue;
    let j = i + 10;
    while (/^\d+$/.test(L[j]) && L[j + 1] && !/^\d+$/.test(L[j + 1])) {
      const r = L.slice(j, j + 11);
      out.push({ team: kn(r[1]), mj: +r[2], v: +r[3], vo: +r[4], d: +r[5], dp: +r[6], bp: +r[7], bc: +r[8], pts: +r[10] });
      j += 11;
    }
  }
  const seen = new Set<string>();
  return out.filter(r => !seen.has(r.team) && seen.add(r.team));
}
export async function khlNow(seasonStartYear: number) {
  const [cal, tab] = await Promise.all([txt('https://www.sports.ru/hockey/tournament/khl/calendar/'), txt('https://www.sports.ru/hockey/tournament/khl/table/')]);
  return { ok: !!cal && !!tab, upcoming: cal ? parseKhlCalendar(cal, seasonStartYear) : [], table: tab ? parseKhlTable(tab) : [], pages: cal ? khlMatchPages(cal) : {} };
}
/** Adresse de la page de chaque match (données structurées du calendrier) : clé « date|domicile|extérieur » (noms français, date de Moscou). */
export function khlMatchPages(html: string) {
  const out: Record<string, string> = {};
  const re = /"startDate":"(\d{4}-\d{2}-\d{2})T[^"]*","endDate":"[^"]*","url":"(https:\/\/www\.sports\.ru\/hockey\/match\/[^"]+)"[\s\S]{0,400}?"homeTeam":\{[^}]*?"name":"([^"]+)"[\s\S]{0,800}?"awayTeam":\{[^}]*?"name":"([^"]+)"/g;
  for (const m of html.matchAll(re)) out[`${m[1]}|${kn(m[3])}|${kn(m[4])}`] = m[2];
  return out;
}
export async function khlSeason(label: string, seasonStartYear: number) {   // ex. « 2025-2026 » (saison complète, scores inclus)
  const h = await txt(`https://www.sports.ru/hockey/tournament/khl/calendar/${label}/`, 20000);
  return h ? parseKhlCalendar(h, seasonStartYear) : [];
}

// ------------------------------------------------------------------ Liiga (liiga.fi, API officielle)
export async function liigaSeason(season: number): Promise<EGame[]> {   // season = année de fin (2027 pour 2026-27)
  const d = await js(`https://liiga.fi/api/v2/games?tournament=runkosarja&season=${season}`, 15000);
  if (!Array.isArray(d)) return [];
  return d.map((g: any) => {
    const ft = String(g.finishedType || '');
    const fin = !g.ended ? null : /SHOOTOUT|WINNING_SHOT/.test(ft) ? 'SO' : /OVERTIME|EXTENDED/.test(ft) ? 'OT' : 'REG';
    const regGoals = (side: 'homeTeam' | 'awayTeam') => (g[side]?.goalEvents || []).filter((e: any) => (e.period ?? 1) <= 3).length;
    const hasEv = Array.isArray(g.homeTeam?.goalEvents);
    return { lg: 'Liiga', id: `LIIGA-${g.season}-${g.id}`, date: String(g.start).slice(0, 10), utc: g.start, dom: g.homeTeam?.teamName, ext: g.awayTeam?.teamName, done: !!g.ended,
      hs: g.ended ? g.homeTeam?.goals : null, as: g.ended ? g.awayTeam?.goals : null, fin, reg_h: g.ended && hasEv ? regGoals('homeTeam') : null, reg_a: g.ended && hasEv ? regGoals('awayTeam') : null } as EGame;
  }).filter((g: EGame) => g.dom && g.ext);
}

// ------------------------------------------------------------------ SHL (shl.se, API du site officiel)
export async function shlSeason(code: string): Promise<EGame[]> {   // code = année de début (« 2026 » pour 2026-27)
  const f = await js('https://www.shl.se/api/sports-v2/season-series-game-types-filter');
  const s = f?.season?.find((x: any) => x.code === code)?.uuid, ser = f?.series?.find((x: any) => x.code === 'SHL')?.uuid, gt = f?.gameType?.find((x: any) => x.code === 'regular')?.uuid;
  if (!s || !ser || !gt) return [];
  const d = await js(`https://www.shl.se/api/sports-v2/game-schedule?seasonUuid=${s}&seriesUuid=${ser}&gameTypeUuid=${gt}`, 15000);
  return (d?.gameInfo || []).map((g: any) => {
    const done = g.state === 'post-game';
    return { lg: 'SHL', id: `SHL-${g.uuid}`, date: String(g.startDateTime || g.rawStartDateTime).slice(0, 10), utc: g.rawStartDateTime, dom: g.homeTeamInfo?.names?.long || g.homeTeamInfo?.code, ext: g.awayTeamInfo?.names?.long || g.awayTeamInfo?.code,
      done, hs: done ? g.homeTeamInfo?.score : null, as: done ? g.awayTeamInfo?.score : null, fin: done ? (g.shootout ? 'SO' : g.overtime ? 'OT' : 'REG') : null } as EGame;
  }).filter((g: EGame) => g.dom && g.ext);
}
