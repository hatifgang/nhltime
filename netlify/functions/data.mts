import { kv } from './lib/store.mts';

export default async (req: Request) => {
  const what = new URL(req.url).searchParams.get('what');
  const store = kv();
  const body = what === 'history' ? await store.getJSON('db') : await store.getJSON('latest');
  return Response.json(body || null, { headers: { 'Cache-Control': 'no-store' } });
};
export const config = { path: '/api/data' };
