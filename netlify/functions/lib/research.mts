// Recherche web avant chaque mise à jour : actus récentes des deux équipes (Google News, sans clé), puis, si une clé
// d'IA gratuite est configurée (GEMINI_API_KEY : Google AI Studio, avec recherche Google ; sinon GROQ_API_KEY),
// une analyse « pour / contre » de chaque match qui tient compte de nos chiffres. L'IA peut proposer un petit
// ajustement (± 6 points au plus) : il est affiché et mesuré à part, jamais appliqué en aveugle.
import { getText, r3, pool } from './util.mts';

export interface Game { sport: string; game_id: string; match: string; dom: string; ext: string; nom_dom: string; nom_ext: string; heure: string; utc: string | null; resume: string; p_dom: number | null }

const strip = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim();
async function headlines(q: string, n = 6) {
  const xml = await getText(`https://news.google.com/rss/search?q=${encodeURIComponent(`"${q}" when:3d`)}&hl=en-US&gl=US&ceid=US:en`);
  if (!xml) return [];
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, n).map(m => {
    const t = strip((m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ''), d = (m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '', l = strip((m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
    return { titre: t, date: d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '', lien: l };
  });
}

const PROMPT = (g: Game, hd: any[], he: any[]) => `Tu es un analyste de paris sportifs prudent. Match ${g.sport} : ${g.nom_ext} (extérieur) chez ${g.nom_dom} (domicile), ${g.heure} heure de Paris.
Nos chiffres (déjà calculés à partir des statistiques et des cotes) : ${g.resume}
Actus récentes ${g.nom_dom} : ${hd.map(h => `- ${h.titre} (${h.date})`).join(' ') || 'aucune'}
Actus récentes ${g.nom_ext} : ${he.map(h => `- ${h.titre} (${h.date})`).join(' ') || 'aucune'}
Cherche aussi sur le web les infos de dernière minute : blessés et absents confirmés, gardien ou joueurs reposés, fatigue (matchs rapprochés, voyage), motivation, série en cours, changement d'entraîneur.
Pèse le pour et le contre pour chaque équipe. Ne propose un ajustement que pour une info récente que nos chiffres ne connaissent probablement pas (blessure annoncée aujourd'hui, star reposée...). Sinon ajustement 0.
Réponds UNIQUEMENT en JSON valide, en français, sans texte autour :
{"pour_dom":["..."],"pour_ext":["..."],"absences":["..."],"ajustement_dom":0,"confiance":"faible|moyenne|forte","verdict":"une phrase"}
ajustement_dom = points de pourcentage à ajouter aux chances de victoire de ${g.nom_dom}, entier entre -6 et 6.`;

function parseJson(t: string) {
  const m = t.match(/\{[\s\S]*\}/); if (!m) return null;
  try { const j = JSON.parse(m[0]); j.ajustement_dom = Math.max(-6, Math.min(6, Math.round(+j.ajustement_dom || 0))); return j; } catch { return null; }
}
async function gemini(prompt: string, key: string) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2 } }) });
  if (!r.ok) throw new Error(`Gemini ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const text = (j.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('');
  const src = (j.candidates?.[0]?.groundingMetadata?.groundingChunks || []).map((c: any) => c.web?.title).filter(Boolean).slice(0, 5);
  return { ...parseJson(text), sources_web: src, moteur: `Gemini (${model}) + recherche Google` };
}
async function groq(prompt: string, key: string) {
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt.replace('Cherche aussi sur le web', 'À partir de ces actus, relève') }] }) });
  if (!r.ok) throw new Error(`Groq ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return { ...parseJson(j.choices?.[0]?.message?.content || ''), sources_web: [], moteur: `Groq (${model}), à partir des actus Google News` };
}

const NHL_NOM: Record<string, string> = {"ANA": "Anaheim Ducks", "BOS": "Boston Bruins", "BUF": "Buffalo Sabres", "CGY": "Calgary Flames", "CAR": "Carolina Hurricanes", "CHI": "Chicago Blackhawks", "COL": "Colorado Avalanche", "CBJ": "Columbus Blue Jackets", "DAL": "Dallas Stars", "DET": "Detroit Red Wings", "EDM": "Edmonton Oilers", "FLA": "Florida Panthers", "LAK": "Los Angeles Kings", "MIN": "Minnesota Wild", "MTL": "Montreal Canadiens", "NSH": "Nashville Predators", "NJD": "New Jersey Devils", "NYI": "New York Islanders", "NYR": "New York Rangers", "OTT": "Ottawa Senators", "PHI": "Philadelphia Flyers", "PIT": "Pittsburgh Penguins", "SJS": "San Jose Sharks", "SEA": "Seattle Kraken", "STL": "St. Louis Blues", "TBL": "Tampa Bay Lightning", "TOR": "Toronto Maple Leafs", "UTA": "Utah Mammoth", "VAN": "Vancouver Canucks", "VGK": "Vegas Golden Knights", "WSH": "Washington Capitals", "WPG": "Winnipeg Jets"};
/** Matchs à venir (dans les 30 h) des pages NHL, NBA et foot. */
export function upcomingGames(nhl: any, nba: any, foot: any, now = Date.now()): Game[] {
  const out: Game[] = [];
  const P = (x: any) => x == null ? '?' : Math.round(x * 100) + ' %';
  for (const g of nhl?.games || []) if (['FUT', 'PRE'].includes(g.etat))
    out.push({ sport: 'NHL', game_id: String(g.game_id), match: `${g.exterieur} @ ${g.domicile}`, dom: g.domicile, ext: g.exterieur, nom_dom: NHL_NOM[g.domicile] || g.domicile, nom_ext: NHL_NOM[g.exterieur] || g.exterieur, heure: g.debut_paris, utc: null, p_dom: g.p_dom,
      resume: `victoire (prolongation incluse) ${g.domicile} ${P(g.p_dom)}, ${g.exterieur} ${P(g.p_ext)} ; buts attendus ${g.buts_attendus_dom}-${g.buts_attendus_ext} ; ${(g.logique || []).filter((l: string) => /gardien|absen|2e match|chanceux|forme/i.test(l)).slice(0, 6).join(' ; ')}` });
  for (const g of nba?.games || []) if (g.etat === 'pre')
    out.push({ sport: 'NBA', game_id: String(g.game_id), match: `${g.exterieur} @ ${g.domicile}`, dom: g.domicile, ext: g.exterieur, nom_dom: g.nom_dom || g.domicile, nom_ext: g.nom_ext || g.exterieur, heure: g.debut_paris, utc: null, p_dom: g.p_dom,
      resume: `victoire ${g.domicile} ${P(g.p_dom)}, ${g.exterieur} ${P(g.p_ext)} ; écart attendu ${g.ecart_dom ?? '?'} pour le domicile, total ${g.total ?? '?'} ; absents : ${JSON.stringify(g.absents || {}).slice(0, 300)}` });
  for (const m of foot?.matchs || []) if (m.utc && Date.parse(m.utc) > now && Date.parse(m.utc) < now + 30 * 3600000)
    out.push({ sport: m.lg, game_id: String(m.game_id), match: m.match, dom: m.dom, ext: m.ext, nom_dom: m.dom, nom_ext: m.ext, heure: m.heure, utc: m.utc, p_dom: m.p60?.dom ?? null,
      resume: `domicile ${P(m.p60?.dom)}, nul ${P(m.p60?.nul)}, extérieur ${P(m.p60?.ext)} ; buts attendus ${m.buts?.dom}-${m.buts?.ext}` });
  return out;
}

/** Passage complet (cache 8 h par match ; 45 appels d'IA au plus par passage). */
export async function runResearch(db: any, nhl: any, nba: any, foot: any) {
  db.matchs ||= {};
  const games = upcomingGames(nhl, nba, foot);
  const gk = process.env.GEMINI_API_KEY, qk = process.env.GROQ_API_KEY;
  let calls = 0, errors: string[] = [];
  await pool(games, 4, async g => {
    const k = `${g.sport}:${g.game_id}`, old = db.matchs[k];
    if (old && Date.now() - old.t < 8 * 3600000 && (old.ia || !(gk || qk))) return;
    const [hd, he] = await Promise.all([headlines(g.nom_dom), headlines(g.nom_ext)]);
    let ia: any = null;
    if ((gk || qk) && calls < 45) {
      calls++;
      try { ia = gk ? await gemini(PROMPT(g, hd, he), gk) : await groq(PROMPT(g, hd, he), qk!); }
      catch (e: any) { errors.push(String(e.message || e).slice(0, 160)); if (gk && qk) { try { ia = await groq(PROMPT(g, hd, he), qk); } catch {} } }
    }
    db.matchs[k] = { t: Date.now(), ...g, actus_dom: hd, actus_ext: he, ia: ia && ia.verdict ? ia : null };
  });
  // nettoyage : matchs de plus de 3 jours
  for (const [k, v] of Object.entries<any>(db.matchs)) if (Date.now() - v.t > 3 * 86400000) delete db.matchs[k];
  const list = games.map(g => db.matchs[`${g.sport}:${g.game_id}`]).filter(Boolean);
  return { genere: new Date().toISOString(), moteur: gk ? 'Gemini + recherche Google' : qk ? 'Groq + Google News' : null, matchs: list, appels: calls, erreurs: errors.slice(0, 3) };
}
