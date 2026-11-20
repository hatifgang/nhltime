// MISE À JOUR NBA automatique : 07:00 UTC (8 h–9 h Paris), après la nuit de matchs.
import { runNba } from './lib/nba/pipeline.mts';
export default async () => { const r = await runNba('update', { trigger: 'automatique' }); console.log(JSON.stringify(r)); };
export const config = { schedule: '5 7 * * *' };
