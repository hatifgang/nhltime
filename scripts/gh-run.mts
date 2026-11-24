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
const nhlL = rd('latest.json'), nbaL = rd('nba_latest.json'), eurL = rd('europe_latest.json'), footL = rd('foot_latest.json'), tenL = rd('tennis_latest.json');
const ndb = rd('nba_db.json'); if (ndb) delete ndb.boxes;   // boîtes de score brutes : trop lourdes pour l'Excel
// historique NHL allégé pour l'Excel (60 derniers jours)
const hdb = rd('db.json'); const cut = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
if (hdb) for (const k of Object.keys(hdb)) if (Array.isArray(hdb[k])) hdb[k] = hdb[k].filter((x: any) => !x?.date || String(x.date) >= cut);

// aperçu public : vrais résultats et 1 prono gratuit
const stats: any[] = [];
const v = (nhlL?.reliability || []).find((r: any) => r.type === 'Vainqueur'); if (v?.n) stats.push({ nom: 'NHL · vainqueurs', n: v.n, gagnes: Math.round(v.reussite_fav * v.n), prevu: v.prevu_moy });
const b = (nbaL?.reliability || []).find((r: any) => r.type === 'Vainqueur'); if (b?.n) stats.push({ nom: 'NBA · vainqueurs', n: b.n, gagnes: b.gagnes, prevu: b.prevu });
for (const [nom, L] of [['KHL, SHL, Liiga', eurL], ['Football', footL]] as const) if (L?.bilan?.total?.n) stats.push({ nom, n: L.bilan.total.n, gagnes: L.bilan.total.gagnes, prevu: L.bilan.total.prevu });
if (tenL?.bilan?.n) stats.push({ nom: 'Tennis', n: tenL.bilan.n, gagnes: tenL.bilan.gagnes, prevu: tenL.bilan.prevu });
if (mix?.bilan?.n) stats.push({ nom: 'Combinés à cote 2', n: mix.bilan.n, gagnes: mix.bilan.gagnes, prevu: null });
const cands = [...(footL?.picks || []).map((x: any) => ({ ...x, sport: x.lg })), ...(eurL?.picks || []).map((x: any) => ({ ...x, sport: x.lg }))]
  .filter((x: any) => x.prob >= 0.6 && x.prob <= 0.8 && x.utc && Date.parse(x.utc) > Date.now()).sort((a: any, c: any) => c.prob - a.prob);
const g = cands[0];
wr('apercu.json', { genere: new Date().toISOString(), stats: stats.filter(x => x.prevu != null || x.n), gratuit: g ? { label: g.label, sport: g.sport, match: g.match, heure: g.heure, prob: g.prob, cote_min: g.cote_min } : null });

const { sbOn, vipUpsert, sbUrl } = await import('./sb.mts');
if (sbOn()) {
  // abonnements actifs : contenu VIP dans Supabase (lu seulement par les abonnés), rien en clair sur le site
  try {
    await vipUpsert([
      { categorie: 'nhl', cle: 'nhl', contenu: nhlL }, { categorie: 'nhl', cle: 'historique', contenu: hdb }, { categorie: 'nhl', cle: 'europe', contenu: eurL },
      { categorie: 'nba', cle: 'nba', contenu: nbaL }, { categorie: 'nba', cle: 'historique', contenu: ndb },
      { categorie: 'foot', cle: 'foot', contenu: footL }, { categorie: 'tennis', cle: 'tennis', contenu: tenL },
      { categorie: 'paris_du_jour', cle: 'mix', contenu: mix }, { categorie: 'paris_du_jour', cle: 'recherche', contenu: research },
    ]);
    console.log('contenu VIP envoyé à Supabase');
  } catch (e: any) { console.error('ÉCHEC envoi VIP :', String(e?.message || e).replace(/https?:\/\/\S+/g, '[adresse]')); }
  fs.writeFileSync(path.join(S, 'config.js'), `window.NT_CONFIG = ${JSON.stringify({ url: sbUrl(), anon: (process.env.SUPABASE_ANON_KEY || '').trim() })};\n`);
} else {
  // pas encore de Supabase : le site reste ouvert à tous, comme avant
  wr('data.json', nhlL); wr('history.json', rd('db.json')); wr('mescotes.json', rd('mescotes.json') || {});
  wr('nba/data.json', nbaL); wr('nba/history.json', ndb); wr('europe/data.json', eurL);
  wr('mix.json', mix); wr('recherche.json', research); wr('foot/data.json', footL); wr('tennis/data.json', tenL);
}
console.log('site construit :', fs.readdirSync(path.join(S, 'api')).join(', '));
if (fail) console.log(`${fail} analyse(s) en échec : le site est quand même reconstruit avec les dernières données.`);
