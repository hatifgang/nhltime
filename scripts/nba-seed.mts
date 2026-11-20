// Chargement initial NBA (une fois, en local) : boîtes de score ESPN de la saison passée (calage) et de la saison en cours (base du site).
// Usage : node scripts/nba-seed.mts <dossier_cache>
import fs from 'node:fs';
import path from 'node:path';
import { scoreboard, boxscore, seasonAverages } from '../netlify/functions/lib/nba/espn.mts';
import { pool, addDays } from '../netlify/functions/lib/util.mts';

const dir = process.argv[2];
fs.mkdirSync(dir, { recursive: true });
const ranges: [string, string, string][] = [['2025-10-21', '2026-04-12', 'last'], ['2026-10-15', '2026-11-08', 'cur']];
for (const [a, b, tag] of ranges) {
  const f = path.join(dir, `boxes_${tag}.json`);
  const have: Record<string, any> = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  const dates: string[] = []; for (let d = a; d <= b; d = addDays(d, 1)) dates.push(d);
  const sbs = await pool(dates, 6, async d => (await scoreboard(d)).filter(g => g.termine).map(g => ({ id: g.id, d })));
  const todo = sbs.flat().filter(x => !have[x.id]);
  console.log(tag, 'matchs', sbs.flat().length, 'à charger', todo.length);
  let n = 0;
  await pool(todo, 6, async x => { const bx = await boxscore(x.id, x.d); if (bx) have[x.id] = bx; if (++n % 100 === 0) { console.log(tag, n); fs.writeFileSync(f, JSON.stringify(have)); } });
  fs.writeFileSync(f, JSON.stringify(have));
  console.log(tag, 'ok', Object.keys(have).length);
}
for (const s of [2026, 2025]) fs.writeFileSync(path.join(dir, `avg_${s}.json`), JSON.stringify(await seasonAverages(s)));
console.log('moyennes ok');
