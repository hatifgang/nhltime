// Supabase côté analyse automatique (clé de service, jamais envoyée au navigateur) :
// contenu VIP (table vip_content) et stockage privé des données (bucket « data »).
// Usage : node --experimental-strip-types scripts/sb.mts pull|push <dossier>
import fs from 'node:fs';
import path from 'node:path';

const URL_ = process.env.SUPABASE_URL || '', KEY = process.env.SUPABASE_SERVICE_KEY || '';
export const sbOn = () => !!(URL_ && KEY);
const H = (extra: Record<string, string> = {}) => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, ...extra });

export async function vipUpsert(rows: { categorie: string; cle: string; contenu: any }[]) {
  for (const r of rows) {
    if (r.contenu == null) continue;
    const res = await fetch(`${URL_}/rest/v1/vip_content?on_conflict=categorie,cle`, {
      method: 'POST', headers: H({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ ...r, maj: new Date().toISOString() }]) });
    if (!res.ok) throw new Error(`vip_content ${r.categorie}/${r.cle} : ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}
async function list(): Promise<string[]> {
  const r = await fetch(`${URL_}/storage/v1/object/list/data`, { method: 'POST', headers: H({ 'Content-Type': 'application/json' }), body: JSON.stringify({ prefix: '', limit: 1000 }) });
  if (!r.ok) throw new Error(`liste stockage : ${r.status} ${await r.text()}`);
  return ((await r.json()) as any[]).map(o => o.name).filter((n: string) => n.endsWith('.json'));
}
export async function pull(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const names = await list();
  for (const n of names) {
    const r = await fetch(`${URL_}/storage/v1/object/data/${encodeURIComponent(n)}`, { headers: H() });
    if (!r.ok) throw new Error(`lecture ${n} : ${r.status}`);
    fs.writeFileSync(path.join(dir, n), Buffer.from(await r.arrayBuffer()));
  }
  return names.length;
}
export async function push(dir: string) {
  let n = 0;
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
    const r = await fetch(`${URL_}/storage/v1/object/data/${encodeURIComponent(f)}`, { method: 'POST', headers: H({ 'Content-Type': 'application/json', 'x-upsert': 'true' }), body: fs.readFileSync(path.join(dir, f)) });
    if (!r.ok) throw new Error(`écriture ${f} : ${r.status} ${(await r.text()).slice(0, 200)}`);
    n++;
  }
  return n;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('sb.mts')) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd && dir) {
    if (!sbOn()) { console.log('Supabase non configuré'); process.exit(cmd === 'pull' ? 2 : 0); }
    const n = cmd === 'pull' ? await pull(dir) : await push(dir);
    console.log(`${cmd} : ${n} fichier(s)`);
    if (cmd === 'pull' && n === 0) process.exit(2);   // stockage vide : le workflow reprend les données de la branche « data »
  }
}
