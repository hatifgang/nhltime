import { runNba } from './lib/nba/pipeline.mts';

export default async (req: Request) => {
  const url = new URL(req.url);
  if (req.method !== 'POST') return Response.json({ ok: false, message: 'Utilise POST.' }, { status: 405 });
  const mode = url.searchParams.get('mode') === 'prematch' ? 'prematch' : 'update';
  try {
    const out = await runNba(mode, { trigger: 'bouton' });
    return Response.json(out, { status: out.ok ? 200 : 409 });
  } catch (e: any) {
    console.error(e);
    return Response.json({ ok: false, message: 'Échec de l’analyse : ' + String(e?.message || e) }, { status: 500 });
  }
};
export const config = { path: '/api/nba/run' };
