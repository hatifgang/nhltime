// PRÉ-MATCH automatique : 15:30 UTC (matchs d'après-midi) et 21:30 UTC (avant les matchs du soir).
import { runPipeline } from './lib/pipeline.mts';
export default async () => { const r = await runPipeline('prematch', { trigger: 'automatique' }); console.log(JSON.stringify(r)); };
export const config = { schedule: '30 15,21 * * *' };
