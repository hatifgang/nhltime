import { runEurope } from './lib/europe/pipeline.mts';
export default async (req: Request) => {
  if (req.method !== 'POST') return Response.json({ ok: false, message: 'Utilise POST.' }, { status: 405 });
  try { const out = await runEurope({ trigger: 'bouton' }); return Response.json(out, { status: out.ok ? 200 : 409 }); }
  catch (e: any) { console.error(e); return Response.json({ ok: false, message: 'Échec de l’analyse : ' + String(e?.message || e) }, { status: 500 }); }
};
export const config = { path: '/api/europe/run' };
