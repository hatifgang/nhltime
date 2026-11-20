// Hockey européen automatique : 06:10 et 13:10 UTC (matchs KHL dès la fin de matinée à Paris, SHL et Liiga en soirée).
import { runEurope } from './lib/europe/pipeline.mts';
export default async () => { const r = await runEurope({ trigger: 'automatique' }); console.log(JSON.stringify(r)); };
export const config = { schedule: '10 6,13 * * *' };
