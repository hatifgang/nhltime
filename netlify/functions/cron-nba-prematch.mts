// PRÉ-MATCH NBA automatique : 15:30 UTC (provisoire) et 21:30 UTC (final, rapport de blessures plus complet).
import { runNba } from './lib/nba/pipeline.mts';
export default async () => { const r = await runNba('prematch', { trigger: 'automatique' }); console.log(JSON.stringify(r)); };
export const config = { schedule: '35 15,21 * * *' };
