// Cotes saisies à la main par l'utilisateur (Winamax), synchronisées entre ses appareils.
import { kv } from './lib/store.mts';

export default async (req: Request) => {
  const store = kv();
  if (req.method === 'GET') return Response.json((await store.getJSON('mescotes')) || {}, { headers: { 'Cache-Control': 'no-store' } });
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  const incoming = await req.json().catch(() => null);
  if (!incoming || typeof incoming !== 'object' || JSON.stringify(incoming).length > 50000) return Response.json({ ok: false }, { status: 400 });
  const cur = (await store.getJSON('mescotes')) || {};
  for (const [k, v] of Object.entries<any>(incoming)) {
    if (!/^p?\d{1,12}$/.test(k) || typeof v !== 'object') continue;
    const clean: any = { maj: Number(v.maj) || Date.now() };
    for (const f of ['ext', 'dom', 'but', 'passe', 'point']) if (v[f] != null) clean[f] = String(v[f]).slice(0, 8);
    if (!cur[k] || (cur[k].maj || 0) <= clean.maj) cur[k] = clean;
  }
  await store.setJSON('mescotes', cur);
  return Response.json({ ok: true });
};
export const config = { path: '/api/mescotes' };
