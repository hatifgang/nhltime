import { kv } from './lib/store.mts';

export default async (req: Request) => {
  const what = new URL(req.url).searchParams.get('what');
  const store = kv('nba');
  if (what === 'history') {
    const db = await store.getJSON('db');
    if (!db) return Response.json(null);
    const { boxes, ...rest } = db;   // les boîtes de score brutes ne servent pas à l'Excel (trop lourdes)
    return Response.json(rest, { headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json((await store.getJSON('latest')) || null, { headers: { 'Cache-Control': 'no-store' } });
};
export const config = { path: '/api/nba/data' };
