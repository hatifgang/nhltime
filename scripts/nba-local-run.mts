import { runNba } from '../netlify/functions/lib/nba/pipeline.mts';
const mode = (process.argv[2] as any) || 'prematch';
const t = Date.now();
const r = await runNba(mode, { force: true, trigger: 'test local', date: process.argv[3] });
console.log(JSON.stringify(r, null, 1), ((Date.now() - t) / 1000).toFixed(1) + ' s');
