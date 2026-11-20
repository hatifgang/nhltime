// MISE À JOUR automatique : 07:00 UTC (9 h à Paris en été, 8 h en hiver).
import { runPipeline } from './lib/pipeline.mts';
export default async () => { const r = await runPipeline('update', { trigger: 'automatique' }); console.log(JSON.stringify(r)); };
export const config = { schedule: '0 7 * * *' };
