import { fetchCovers } from '../netlify/functions/lib/covers.mts';
import { get, nm, norm } from '../netlify/functions/lib/util.mts';
const st = (await get('https://api-web.nhle.com/v1/standings/now')).standings;
const map: Record<string, string> = {};
for (const s of st) map[norm(nm(s.placeName))] = nm(s.teamAbbrev);
const r = await fetchCovers(map);
console.log(r.ok, r.reason, r.games.length);
for (const g of r.games) console.log(JSON.stringify(g));
