import { runTennis } from '../netlify/functions/lib/tennis/pipeline.mts';
const r = await runTennis({ trigger: 'test local', now: process.argv[2] ? new Date(process.argv[2]) : undefined });
console.log(JSON.stringify(r));
