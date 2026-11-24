// Version GitHub : lance les analyses (stockage = dossier data/), puis fabrique le site statique dans site/.
// Usage : node --experimental-strip-types scripts/gh-run.mts nhl-update nba-prematch europe ...  (aucune tâche = construire le site seulement)
import fs from 'node:fs';
import path from 'node:path';

process.env.NHL_LOCAL_STORE ||= path.resolve('data');
const { runPipeline } = await import('../netlify/functions/lib/pipeline.mts');
const { runNba } = await import('../netlify/functions/lib/nba/pipeline.mts');
const { runEurope } = await import('../netlify/functions/lib/europe/pipeline.mts');
const { runFoot } = await import('../netlify/functions/lib/foot/pipeline.mts');
const { runTennis } = await import('../netlify/functions/lib/tennis/pipeline.mts');

const trigger = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? 'bouton' : 'automatique';
const tasks: Record<string, () => Promise<any>> = {
  'nhl-update': () => runPipeline('update', { trigger }),
  'nhl-prematch': () => runPipeline('prematch', { trigger }),
  'nba-update': () => runNba('update', { trigger }),
  'nba-prematch': () => runNba('prematch', { trigger }),
  'europe': () => runEurope({ trigger }),
  'foot': () => runFoot({ trigger }),
  'tennis': () => runTennis({ trigger }),
};
let fail = 0;
for (const t of process.argv.slice(2)) {
  if (!tasks[t]) { console.log(`tâche inconnue : ${t}`); continue; }
  const t0 = Date.now();
  try { const r = await tasks[t](); console.log(t, JSON.stringify(r?.log || r), `${((Date.now() - t0) / 1000).toFixed(1)} s`); }
  catch (e: any) { fail++; console.error(`ÉCHEC ${t} :`, e?.stack || e); }
}

// ---- site statique : pages + données
const D = process.env.NHL_LOCAL_STORE!, S = path.resolve('site');
const rd = (f: string) => { try { return JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')); } catch { return null; } };

// ---- recherche web avant la mise à jour : actus des deux équipes + avis d'une IA gratuite si une clé est configurée
const { runResearch } = await import('../netlify/functions/lib/research.mts');
let research: any = null;
try {
  const rdb = rd('research_db.json') || {};
  research = await runResearch(rdb, rd('latest.json'), rd('nba_latest.json'), rd('foot_latest.json'));
  fs.writeFileSync(path.join(D, 'research_db.json'), JSON.stringify(rdb));
  console.log('recherche web :', research.matchs.length, 'match(s),', research.appels, "appel(s) d'IA", research.moteur || '(pas de clé : actus seulement)', research.erreurs.join(' | '));
} catch (e: any) { console.error('ÉCHEC recherche web :', e?.stack || e); }

// ---- combinés « mélange » des choix des autres parieurs (NHL + NBA + KHL)
const { runMix } = await import('../netlify/functions/lib/mix.mts');
let mix: any = null;
try {
  const mdb = rd('mix_db.json') || {};
  mix = await runMix(mdb, rd('latest.json'), rd('nba_latest.json'), rd('europe_latest.json'), research);
  fs.writeFileSync(path.join(D, 'mix_db.json'), JSON.stringify(mdb));
  console.log('combinés :', mix.combos.length, 'proposé(s),', mix.legs.length, 'sélection(s) du public,', mix.graded, 'noté(s)');
} catch (e: any) { console.error('ÉCHEC combinés :', e?.stack || e); }
const wr = (f: string, v: any) => { const p = path.join(S, 'api', f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v ?? null)); };
fs.rmSync(S, { recursive: true, force: true });
fs.cpSync(path.resolve('public'), S, { recursive: true });
fs.writeFileSync(path.join(S, '.nojekyll'), '');
wr('data.json', rd('latest.json'));
wr('history.json', rd('db.json'));
wr('mescotes.json', rd('mescotes.json') || {});
wr('nba/data.json', rd('nba_latest.json'));
const ndb = rd('nba_db.json'); if (ndb) delete ndb.boxes;   // boîtes de score brutes : trop lourdes pour l'Excel
wr('nba/history.json', ndb);
wr('europe/data.json', rd('europe_latest.json'));
wr('mix.json', mix);
wr('recherche.json', research);
wr('foot/data.json', rd('foot_latest.json'));
wr('tennis/data.json', rd('tennis_latest.json'));
console.log('site construit :', fs.readdirSync(path.join(S, 'api')).join(', '));
if (fail) console.log(`${fail} analyse(s) en échec : le site est quand même reconstruit avec les dernières données.`);
