import { kv } from './lib/store.mts';
export default async () => Response.json((await kv('europe').getJSON('latest')) || null, { headers: { 'Cache-Control': 'no-store' } });
export const config = { path: '/api/europe/data' };
