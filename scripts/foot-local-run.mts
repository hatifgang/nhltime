import { runFoot } from '../netlify/functions/lib/foot/pipeline.mts';
const r = await runFoot({ trigger: 'test local' });
console.log(JSON.stringify(r));
