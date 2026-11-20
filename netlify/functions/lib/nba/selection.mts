// Sélection du soir NBA : mêmes blocs que le site NHL, adaptés au basket.
import { r3, clamp } from '../util.mts';
import * as M from './model.mts';
import { legLabel } from '../olbg.mts';

const leg = (o: any) => o;
const fairOdds = (p: number) => r3(1 / Math.max(0.01, p), 2)!;
const estBook = (p: number) => r3(Math.max(1.08, 0.93 / p), 2)!;   // cote bookmaker estimée (marge d'environ 7 %) quand aucune n'est publiée

export function buildSelection(games: any[], players: any[], started: Set<string>, db: any, P: M.NbaParams, tb: any, cov: any, OL: any = { ok: false, games: [] }) {
  const preds: any[] = [];
  const G = (id: string) => games.find(g => g.game_id === id);
  const open = (p: any) => !started.has(p.game_id) && !p.absent && !p.incertain;
  const el = players.filter(p => open(p) && p.mj >= 5 && p.fiabilite >= 45);
  const limit = (list: any[], perTeam: number, perGame: number, n: number) => {
    const out: any[] = [], t: Record<string, number> = {}, g: Record<string, number> = {};
    for (const x of list) { if ((t[x.equipe] || 0) >= perTeam || (g[x.game_id] || 0) >= perGame) continue; out.push(x); t[x.equipe] = (t[x.equipe] || 0) + 1; g[x.game_id] = (g[x.game_id] || 0) + 1; if (out.length === n) break; }
    return out;
  };
  const titu = (p: any) => /Titulaire/.test(p.titulaire);
  const card = (p: any, stat: M.Stat, k: number, extra: string[] = []) => ({ id: p.id, nom: p.nom, equipe: p.equipe, opp: p.adversaire, pos: p.pos, game_id: p.game_id, match: p.match, heure: G(p.game_id)?.debut_paris,
    stat, seuil: k, prob: p.p[stat][k], cote_juste: fairOdds(p.p[stat][k]), fiabilite: p.fiabilite, titulaire: p.titulaire, mu: p.mu[stat], p_30: p.p_30, p_plus5: p.p[stat][k + 5] ?? null,
    raisons: [...extra, ...p.raisons, `Forme : ${p.l10.pts ?? '—'} pts sur 10 matchs (saison ${p.saison.pts}).${p.sequence ? ' Séquence : ' + p.sequence + '.' : ''}`] });

  // ---- 1. 5 joueurs les plus probables de faire X points
  const ptsC = el.filter(p => p.min_prevues >= 24 && p.ligne_pts != null && p.ligne_pts >= 15).map(p => ({ ...p, _p: p.p.pts[p.ligne_pts] }))
    .sort((a, b) => b._p - a._p || b.ligne_pts - a.ligne_pts);
  const surIds = new Set(limit(ptsC.filter(p => p._p >= 0.8 && p.min_prevues >= 30 && titu(p) && p.fiabilite >= 65), 1, 1, 3).map(p => p.id));
  const points = limit(ptsC, 2, 3, 5).map(p => ({ ...card(p, 'pts', p.ligne_pts), niveau: surIds.has(p.id) ? 'Choix sûr' : 'Complément' }));
  for (const c of points) preds.push({ type: 'Sélection points', game_id: c.game_id, selection: `${c.nom} : ${c.seuil}+ points`, prob: c.prob, niveau: c.niveau, legs: [{ kind: 'stat', stat: 'pts', k: c.seuil, player_id: c.id, game_id: c.game_id }] });

  // ---- 2. Équipes les plus sûres
  const equipes = games.filter(g => !started.has(g.game_id)).map(g => { const dom = g.p_dom >= g.p_ext; return { game_id: g.game_id, equipe: dom ? g.domicile : g.exterieur, adversaire: dom ? g.exterieur : g.domicile, match: `${g.exterieur} @ ${g.domicile}`,
    lieu: dom ? 'à domicile' : 'à l’extérieur', prob: dom ? g.p_dom : g.p_ext, cote: dom ? g.cote_dom : g.cote_ext, imp: dom ? g.imp_dom : g.imp_ext, confiance: g.confiance, solide: !!g.cote_dom && g.confiance !== 'Faible',
    raisons: [`Écart attendu : ${Math.abs(g.ecart_dom)} points pour ${dom ? g.domicile : g.exterieur}.`, ...g.base.slice(0, 4)] }; })
    .sort((a, b) => b.prob - a.prob).slice(0, 3);
  for (const t of equipes) preds.push({ type: 'Sélection équipe', game_id: t.game_id, selection: `${t.equipe} gagne`, prob: t.prob, cote: t.cote, legs: [{ kind: 'win', team: t.equipe, game_id: t.game_id }] });

  // ---- 3. Objectif 80 % : rebonds, passes, 3 points, points + rebonds + passes
  const MIN80: Record<string, number> = { reb: 4, ast: 4, p3: 2, pra: 20 };
  const c80: any[] = [];
  for (const p of el.filter(p => p.min_prevues >= 22)) for (const s of ['reb', 'ast', 'p3', 'pra'] as M.Stat[]) {
    let k: number | null = null; for (const x of M.LADDER[s]) if (p.p[s][x] >= 0.8 && x >= MIN80[s]) k = x;
    if (k != null) c80.push({ ...p, _s: s, _k: k, _p: p.p[s][k] });
  }
  c80.sort((a, b) => b._p - a._p);
  const seenP = new Set<string>(), o80: any[] = [];
  for (const x of c80) { if (seenP.has(x.id) || o80.filter(y => y.game_id === x.game_id).length >= 1) continue; seenP.add(x.id); o80.push(x); if (o80.length === 3) break; }
  const objectif80 = o80.map(x => card(x, x._s, x._k, [`${x._k}+ ${M.STAT_LAB[x._s as M.Stat]} : ${r3(x.mu[x._s], 1)} attendus, ${x.l10[x._s] ?? '—'} sur 10 matchs, ${x.saison[x._s] ?? '—'} sur la saison.`]));
  for (const c of objectif80) preds.push({ type: 'Objectif 80 %', game_id: c.game_id, selection: `${c.nom} : ${c.seuil}+ ${M.STAT_LAB[c.stat as M.Stat]}`, prob: c.prob, legs: [{ kind: 'stat', stat: c.stat, k: c.seuil, player_id: c.id, game_id: c.game_id }] });

  // ---- 4. 30+ points
  const trente = limit(el.filter(p => p.min_prevues >= 28 && p.p_30 >= 0.12).sort((a, b) => b.p_30 - a.p_30), 1, 2, 5).map(p => card(p, 'pts', 30));
  for (const c of trente) preds.push({ type: 'Sélection 30+ points', game_id: c.game_id, selection: `${c.nom} : 30+ points`, prob: c.prob, legs: [{ kind: 'stat', stat: 'pts', k: 30, player_id: c.id, game_id: c.game_id }] });

  // ---- 5. Meilleur marqueur du soir
  const mm = el.filter(p => p.min_prevues >= 28).sort((a, b) => b.mu.pts - a.mu.pts);
  let buteur: any = null;
  if (mm[0]) {
    const p = mm[0], g = G(p.game_id), home = p.equipe === g.domicile;
    let k = 20; for (const x of [20, 25, 30, 35]) if (p.p.pts[x] >= 0.55) k = x;
    const atouts: string[] = [], risques: string[] = [];
    if (p.min_prevues >= 34) atouts.push(`Gros temps de jeu : ${p.min_prevues} min attendues.`);
    if ((p.usage ?? 0) >= 28) atouts.push(`Usage élevé : ${p.usage} % des possessions de son équipe passent par lui.`);
    if (g && Math.abs(g.ecart_dom) <= 6) atouts.push('Match serré attendu : les titulaires restent sur le terrain jusqu’au bout.'); else risques.push(`Écart attendu de ${Math.abs(g.ecart_dom)} points : risque de match plié et de minutes coupées.`);
    if (p.serie === 'malchanceux') atouts.push('Adresse à 3 points sous sa normale : elle devrait revenir.');
    if (p.serie === 'flatteuse') risques.push('Adresse à 3 points au-dessus de sa normale : je la ramène vers sa moyenne.');
    if (g?.repos?.[home ? 'dom' : 'ext']?.b2b) risques.push('2e soir de suite : fatigue possible ou repos décidé tard.');
    if (p.fiabilite < 60) risques.push(`Fiabilité moyenne (${p.fiabilite}/100) : peu de matchs ou minutes irrégulières.`);
    buteur = { id: p.id, nom: p.nom, equipe: p.equipe, adversaire: p.adversaire, pos: p.pos, game_id: p.game_id, match: p.match, heure: g?.debut_paris, mu: p.mu.pts, seuil: k, prob: p.p.pts[k], cote_juste: fairOdds(p.p.pts[k]),
      p25: p.p.pts[25], p30: p.p.pts[30], p35: p.p.pts[35], cote_25: fairOdds(p.p.pts[25]), cote_30: fairOdds(p.p.pts[30]), fiabilite: p.fiabilite, titulaire: p.titulaire,
      joueur: [`Saison : ${p.saison.pts} pts en ${p.saison.min} min (${p.mj} matchs), ${p.saison.fg ?? '—'} % aux tirs, ${p.saison.p3pct ?? '—'} % à 3 points.`, `10 derniers matchs : ${p.l10.pts} pts (${p.forme.join(', ')}).`, p.prec ? `Saison passée : ${p.prec.pts} pts.` : 'Pas de saison passée en NBA.', `Contre ${p.adversaire} : ${p.vs_adv}.`],
      equipes: g ? g.base.slice(0, 3) : [], atouts, risques, raisons: p.raisons,
      derriere: mm.slice(1, 3).map(q => ({ nom: q.nom, equipe: q.equipe, mu: q.mu.pts, p30: q.p_30 })) };
    preds.push({ type: 'Meilleur marqueur du soir', game_id: p.game_id, selection: `${p.nom} : ${k}+ points`, prob: p.p.pts[k], legs: [{ kind: 'stat', stat: 'pts', k, player_id: p.id, game_id: p.game_id }] });
  }

  // ---- réservoir de jambes (marché quand il existe, sinon cote juste)
  const legs: any[] = [];
  for (const g of games.filter(g => !started.has(g.game_id))) {
    const m = `${g.exterieur} @ ${g.domicile}`;
    for (const [t, p, c] of [[g.domicile, g.p_dom, g.cote_dom], [g.exterieur, g.p_ext, g.cote_ext]] as const)
      legs.push({ kind: 'win', team: t, game_id: g.game_id, match: m, label: `${t} gagne (prolongation incluse)`, prob: p, cote: c || fairOdds(p), marche: !!c });
    const sp = g.marches?.spread, to = g.marches?.total;
    if (sp) for (const [t, line, p, c] of [[g.domicile, sp.line_dom, sp.p_dom, sp.cote_dom], [g.exterieur, sp.line_ext, sp.p_ext, sp.cote_ext]] as const)
      if (c) legs.push({ kind: 'spread', team: t, line, game_id: g.game_id, match: m, label: `${t} ${line > 0 ? '+' : ''}${line} (handicap)`, prob: p, cote: c, marche: true });
    if (to) for (const [k, p, c] of [['over', to.p_over, to.cote_over], ['under', to.p_under, to.cote_under]] as const)
      if (c) legs.push({ kind: k, line: to.line, game_id: g.game_id, match: m, label: `${k === 'over' ? 'Plus' : 'Moins'} de ${to.line} points`, prob: p, cote: c, marche: true });
  }
  for (const p of el.filter(p => p.min_prevues >= 22)) {
    const b = { player_id: p.id, game_id: p.game_id, match: p.match, team: p.equipe, marche: false };
    if (p.ligne_pts) legs.push({ ...b, kind: 'stat', stat: 'pts', k: p.ligne_pts, label: `${p.nom} : ${p.ligne_pts}+ points`, prob: p.p.pts[p.ligne_pts], cote: estBook(p.p.pts[p.ligne_pts]), sur: surIds.has(p.id) });
    for (const k of [20, 25, 30, 35]) if (p.p.pts[k] >= 0.25 && p.p.pts[k] < 0.75) legs.push({ ...b, kind: 'stat', stat: 'pts', k, label: `${p.nom} : ${k}+ points`, prob: p.p.pts[k], cote: estBook(p.p.pts[k]) });
    for (const s of ['reb', 'ast'] as M.Stat[]) { const k = p[`ligne_${s}`]; if (k && k >= 4) legs.push({ ...b, kind: 'stat', stat: s, k, label: `${p.nom} : ${k}+ ${M.STAT_LAB[s]}`, prob: p.p[s][k], cote: estBook(p.p[s][k]) }); }
    if (p.p_dd >= 0.25) legs.push({ ...b, kind: 'dd', label: `${p.nom} : double-double`, prob: p.p_dd, cote: estBook(p.p_dd) });
  }

  // ---- 6. Meilleurs paris à cote 2 ou plus
  const cote2 = legs.filter(l => l.marche && l.cote >= 2 && l.prob * l.cote - 1 >= 0.05).sort((a, b) => (b.prob * b.cote) - (a.prob * a.cote)).slice(0, 5)
    .map(l => ({ ...l, ev: r3(l.prob * l.cote - 1), cote_juste: fairOdds(l.prob) }));
  for (const c of cote2) preds.push({ type: 'Cote 2+', game_id: c.game_id, selection: c.label, prob: c.prob, cote: c.cote, legs: [pick(c)] });
  const cote2j = legs.filter(l => !l.marche && l.prob >= 0.4 && 1 / l.prob >= 2).sort((a, b) => b.prob - a.prob).slice(0, 6).map(l => ({ ...l, cote_juste: fairOdds(l.prob) }));

  // ---- 7. Pari safe du jour (modèle « ticket Winamax »)
  const safe = (() => {
    const winL = legs.filter(l => l.kind === 'win' && l.prob >= 0.6 && (G(l.game_id)?.confiance !== 'Faible' || !l.marche));
    const ptL = legs.filter(l => l.kind === 'stat' && l.stat === 'pts' && l.k >= 15 && (l.sur || l.prob >= 0.82));
    const pool = [...winL, ...ptL];
    let best: any = null;
    const rec = (s: number, ch: any[], pr: number, co: number) => {
      const nW = ch.filter(c => c.kind === 'win').length;
      if (ch.length >= 2 && nW >= 1 && ch.length - nW >= 1 && co >= 3 && co <= 4.5) { const sc = pr * co - 0.02 * ch.length; if (!best || sc > best.sc) best = { legs: [...ch], prob: pr, cote: co, sc }; }
      if (ch.length === 4) return;
      for (let i = s; i < pool.length; i++) { const l = pool[i]; if (ch.some(c => c.game_id === l.game_id)) continue; ch.push(l); rec(i + 1, ch, pr * l.prob, co * l.cote); ch.pop(); }
    };
    rec(0, [], 1, 1);
    if (!best) return null;
    return { prob: r3(best.prob), cote: r3(best.cote, 2), cote_juste: fairOdds(best.prob), ev: r3(best.prob * best.cote - 1), provisoire: best.legs.some((l: any) => l.kind === 'win' && !l.marche),
      legs: best.legs.map((l: any) => ({ ...pick(l), label: l.label, match: l.match, prob: r3(l.prob), cote: l.cote, marche: l.marche })) };
  })();
  if (safe) preds.push({ type: 'Pari safe du jour', game_id: safe.legs[0].game_id, selection: safe.legs.map((l: any) => l.label).join(' + '), prob: safe.prob, cote: safe.cote, legs: safe.legs.map(pick) });

  // ---- 8. Paris fun (4 thèmes)
  const themed = (theme: string, target: number, quota: Record<string, [number, number]>, minL: number, maxL: number, filt: (l: any) => boolean) => {
    const kinds = Object.keys(quota);
    const kindOf = (l: any) => l.kind === 'stat' ? (l.stat === 'pts' ? (l.k >= 30 ? 'pts30' : 'pts') : 'autre') : l.kind === 'under' ? 'over' : l.kind;
    const pool = legs.filter(l => filt(l) && kinds.includes(kindOf(l)) && l.prob >= 0.2).map(l => l.marche ? l : { ...l, prob: l.prob * 0.95 })
      .sort((x, y) => y.prob * y.cote - x.prob * x.cote || y.prob - x.prob).slice(0, 40);
    let best: any = null;
    const cnt = (c: any[], k: string) => c.filter(x => kindOf(x) === k).length;
    const rec = (s: number, ch: any[], pr: number, co: number) => {
      if (ch.length >= minL && co >= target && co <= target * 2.5 && kinds.every(k => cnt(ch, k) >= quota[k][0])) { const sc = pr * co - 0.03 * ch.length; if (!best || sc > best.sc) best = { legs: [...ch], prob: pr, cote: co, sc }; }
      if (ch.length === maxL) return;
      for (let i = s; i < pool.length; i++) { const l = pool[i]; if (ch.some(c => c.game_id === l.game_id) || cnt(ch, kindOf(l)) >= quota[kindOf(l)][1]) continue; ch.push(l); rec(i + 1, ch, pr * l.prob, co * l.cote); ch.pop(); }
    };
    rec(0, [], 1, 1);
    return best ? { theme, cible: target, prob: r3(best.prob, 3), cote: r3(best.cote, 2), cote_juste: fairOdds(best.prob), chance: Math.round(1 / best.prob), legs: best.legs.map((l: any) => ({ ...pick(l), label: l.label, match: l.match, prob: r3(l.prob), cote: l.cote, marche: l.marche })) } : null;
  };
  const mega = (() => {
    const chosen: any[] = [];
    for (const g of games.filter(g => !started.has(g.game_id))) {
      const c = legs.filter(l => l.game_id === g.game_id && l.kind === 'stat' && l.stat === 'pts' && l.k >= 10 && l.prob >= 0.72).sort((a, b) => b.prob - a.prob);
      if (!c[0]) continue;
      chosen.push(c[0]);
      const o = c.find(l => l.team !== c[0].team && l.prob >= 0.82); if (o) chosen.push(o);
    }
    if (chosen.length < 3) return null;
    const pr = chosen.reduce((t, l) => t * l.prob, 1);
    return { theme: 'Méga points', cible: null, prob: r3(pr, 4), cote: r3(chosen.reduce((t, l) => t * l.cote, 1), 2), cote_juste: fairOdds(pr), chance: Math.round(1 / pr), legs: chosen.map(l => ({ ...pick(l), label: l.label, match: l.match, prob: r3(l.prob), cote: l.cote, marche: false })) };
  })();
  const fun = [
    themed('Doubles / 30+ points', 5, { dd: [0, 3], pts30: [0, 3] }, 2, 4, () => true),
    themed('Victoire + joueur', 5, { win: [1, 3], pts: [1, 1] }, 2, 4, () => true),
    themed('Mélange', 6, { pts: [1, 1], autre: [1, 1], win: [1, 1], over: [0, 1] }, 3, 4, () => true),
    mega,
  ].filter(Boolean) as any[];
  for (const f of fun) preds.push({ type: `Pari fun ${f.theme}`, game_id: f.legs[0].game_id, selection: f.legs.map((l: any) => l.label).join(' + '), prob: f.prob, cote: f.cote, legs: f.legs.map(pick) });

  // ---- 9. 2 paris d'autres parieurs (Covers) et accord avec eux
  const pFor = (g: any, kind: string, team: string | null, line: number | null) => {
    if (kind === 'win') return team === g.domicile ? g.p_dom : g.p_ext;
    if (kind === 'spread' && line != null) { const mgn = team === g.domicile ? g.ecart_dom : -g.ecart_dom; return clamp(1 - M.Phi((-line - mgn) / P.sm), 0.02, 0.98); }
    if ((kind === 'over' || kind === 'under') && line != null && g.total != null) { const po = clamp(1 - M.Phi((line - g.total) / P.st), 0.02, 0.98); return kind === 'over' ? po : 1 - po; }
    return null;
  };
  const autres: any[] = [];
  for (const b of tb?.parieurs || []) {
    if (autres.length === 2) break;
    const mine = (tb.paris || []).filter((x: any) => x.parieur.nom === b.nom).map((x: any) => { const g = games.find(y => y.exterieur === x.away && y.domicile === x.home); if (!g || started.has(g.game_id)) return null; return { x, g, notre: pFor(g, x.kind, x.team, x.line) }; }).filter(Boolean) as any[];
    if (!mine.length) continue;
    const k = mine.sort((u, v) => (v.notre ?? 0) - (u.notre ?? 0))[0];
    const cote = k.x.cote || (k.x.kind !== 'win' ? 1.91 : null);
    const ev = k.notre != null && cote ? k.notre * cote - 1 : null, pc = k.notre != null ? Math.round(k.notre * 100) : null;
    const lab = k.x.kind === 'win' ? `${k.x.team} gagne` : k.x.kind === 'spread' ? `${k.x.team} ${k.x.line > 0 ? '+' : ''}${k.x.line} (handicap)` : `${k.x.kind === 'over' ? 'Plus' : 'Moins'} de ${k.x.line} points`;
    const chance = b.z < (tb.seuil_chance || 3);
    autres.push({ game_id: k.g.game_id, match: `${k.g.exterieur} @ ${k.g.domicile}`, pari: lab, kind: k.x.kind, team: k.x.team, line: k.x.line, cote: r3(cote, 2),
      parieur: { nom: b.nom, url: b.url, record: `${b.gagnes}-${b.perdus}`, taux: r3(b.taux), borne_basse: r3(b.borne_basse), z: r3(b.z, 2), au_dela_chance: !chance },
      notre: r3(k.notre), ev: r3(ev), verdict_parieur: chance ? 'Peut-être de la chance' : 'Historique au-delà de la chance',
      avis: pc == null ? "Je n'ai pas d'estimation sur ce pari." : pc >= 50 ? (ev != null && ev < 0 ? `Je suis d'accord sur le fond (${pc} %) mais la cote est un peu courte.` : `Je suis d'accord : ${pc} % selon moi.`) : `Je ne suis pas d'accord : ${pc} % selon moi.` });
  }
  const avisOf = (notre: number | null, ev: number | null) => { const pc = notre != null ? Math.round(notre * 100) : null; return pc == null ? "Je n'ai pas d'estimation sur ce pari." : pc >= 50 ? (ev != null && ev < 0 ? `D'accord sur le fond (${pc} %) mais la cote est un peu courte.` : `Je suis d'accord : ${pc} % selon moi.`) : `Je ne suis pas d'accord : ${pc} % selon moi.`; };
  const labOf = (x: any) => x.kind === 'win' ? `${x.team} gagne` : x.kind === 'spread' ? `${x.team} ${x.line > 0 ? '+' : ''}${x.line} (handicap)` : `${x.kind === 'over' ? 'Plus' : 'Moins'} de ${x.line} points`;
  const top5 = (tb?.parieurs || []).slice(0, 5).map((b: any, i: number) => {
    const paris = (tb.paris || []).filter((x: any) => x.parieur.nom === b.nom).map((x: any) => {
      const g = games.find(y => y.exterieur === x.away && y.domicile === x.home); if (!g) return null;
      const notre = pFor(g, x.kind, x.team, x.line), cote = x.cote || (x.kind !== 'win' ? 1.91 : null), ev = notre != null && cote ? notre * cote - 1 : null;
      return { game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, pari: labOf(x), kind: x.kind, team: x.team, line: x.line, cote: r3(cote, 2), notre: r3(notre), ev: r3(ev), avis: avisOf(notre, ev), commence: started.has(g.game_id) };
    }).filter(Boolean);
    const me = (db.predictions || []).filter((p: any) => p.type === 'Pari top Covers' && p.parieur === b.nom && (p.resultat === 0 || p.resultat === 1));
    return { rang: i + 1, nom: b.nom, url: b.url, record: `${b.gagnes}-${b.perdus}`, taux: r3(b.taux), unites: b.unites, borne_basse: r3(b.borne_basse), z: r3(b.z, 2), au_dela_chance: b.z >= (tb.seuil_chance || 3), paris, mesure: { n: me.length, gagnes: me.filter((p: any) => p.resultat === 1).length } };
  });
  for (const b of top5) for (const a of b.paris as any[]) if (!a.commence) preds.push({ type: 'Pari top Covers', parieur: b.nom, game_id: a.game_id, selection: `${b.nom} : ${a.pari}`, prob: a.notre ?? 0.5, cote: a.cote, legs: [{ kind: a.kind, team: a.team, line: a.line, game_id: a.game_id }] });
  const GAMES = games, STARTED = started, UNIT = 'points';
  const LEGP = (g: any, l: any) => l ? pFor(g, l.kind, l.team ?? null, l.line ?? null) : null;
  // ---- OLBG : consensus des tipsters et pari du meilleur tipster de chaque match, avec mon avis
  const olbgAvis = (notre: number | null, ev: number | null) => { const pc = notre != null ? Math.round(notre * 100) : null; return pc == null ? "Je n'ai pas d'estimation sur ce pari." : pc >= 50 ? (ev != null && ev < 0 ? `D'accord sur le fond (${pc} %) mais la cote est un peu courte.` : `Je suis d'accord : ${pc} % selon moi.`) : `Je ne suis pas d'accord : ${pc} % selon moi.`; };
  const olbgMatchs = (OL.games || []).map((o: any) => {
    const g = GAMES.find((x: any) => x.exterieur === o.ext && x.domicile === o.dom); if (!g) return null;
    const cote = (l: any) => l?.kind === 'win' ? (l.team === g.domicile ? g.cote_dom : g.cote_ext) : null;
    const enrich = (c: any) => { const notre = LEGP(g, c.leg), ct = cote(c.leg), ev = notre != null && ct ? notre * ct - 1 : null; return { ...c, label: legLabel(c.leg, c.selection, UNIT), notre: r3(notre), cote: r3(ct, 2), ev: r3(ev), avis: olbgAvis(notre, ev) }; };
    const cons = o.consensus.filter((c: any) => c.leg && c.total >= 2).map(enrich);
    const pop = [...cons].sort((a: any, b: any) => b.n - a.n || b.pct - a.pct)[0] || null;
    return { game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, url: o.url, commence: STARTED.has(g.game_id), consensus: cons, populaire: pop, best: o.best && o.best.leg ? enrich(o.best) : null, n_tips: o.tips.length };
  }).filter(Boolean) as any[];
  const olbgTop = olbgMatchs.filter((m: any) => !m.commence).flatMap((m: any) => m.consensus.filter((c: any) => c.total >= 5 && c.pct >= 0.7).map((c: any) => ({ ...c, game_id: m.game_id, match: m.match })))
    .sort((a: any, b: any) => (b.notre ?? 0) - (a.notre ?? 0) || b.n - a.n).slice(0, 5);
  const olbg = { ok: OL.ok, raison: OL.reason || '', matchs: olbgMatchs, top: olbgTop };
  for (const c of olbgTop) preds.push({ type: 'Consensus OLBG', game_id: c.game_id, selection: `${c.label} (${c.n}/${c.total} tipsters)`, prob: c.notre ?? 0.5, cote: c.cote, legs: [{ kind: c.leg.kind, team: c.leg.team, line: c.leg.line, game_id: c.game_id }] });
  for (const m of olbgMatchs) if (!m.commence && m.best) preds.push({ type: 'Pari tipster OLBG', parieur: m.best.tipster, game_id: m.game_id, selection: `${m.best.tipster} : ${m.best.label}`, prob: m.best.notre ?? 0.5, cote: m.best.cote, legs: [{ kind: m.best.leg.kind, team: m.best.leg.team, line: m.best.leg.line, game_id: m.game_id }] });
  for (const a of autres) preds.push({ type: 'Pari parieur Covers', game_id: a.game_id, selection: `${a.parieur.nom} : ${a.pari}`, prob: a.notre ?? 0.5, cote: a.cote, legs: [{ kind: a.kind, team: a.team, line: a.line, game_id: a.game_id }] });
  const sig = (db.signals || []).filter((s: any) => s.res && s.picks?.leaders);
  const lw = sig.filter((s: any) => s.picks.leaders === s.res.vainqueur).length, ln = sig.length, lz = ln ? (lw / ln - 0.5) / Math.sqrt(0.25 / ln) : 0;
  const poids = ln >= 30 && lz >= 1.96 ? 0.25 : 0;
  const accord = games.filter(g => !started.has(g.game_id) && g.parieurs).map(g => {
    const mine = g.p_dom >= g.p_ext ? g.domicile : g.exterieur, pr = g.parieurs;
    const lead = pr.leaders_dom !== pr.leaders_ext && pr.leaders_dom + pr.leaders_ext >= 4 ? (pr.leaders_dom > pr.leaders_ext ? g.domicile : g.exterieur) : null;
    const pub = pr.public_dom >= pr.public_ext ? g.domicile : g.exterieur;
    const pm = Math.max(g.p_dom, g.p_ext), mix = lead ? clamp(pm + poids * (lead === mine ? 0.1 : -0.1), 0.02, 0.98) : pm;
    return { match: `${g.exterieur} @ ${g.domicile}`, mon_favori: mine, leaders: lead ? `${lead} (${Math.max(pr.leaders_dom, pr.leaders_ext)}-${Math.min(pr.leaders_dom, pr.leaders_ext)})` : 'partagés', public: `${pub} ${Math.max(pr.public_dom, pr.public_ext)} %`,
      accord: lead ? (lead === mine ? 'Oui' : 'Non') : '—', mes_chances: r3(pm), mixtes: r3(mix), poids: Math.round(poids * 100) };
  });

  // ---- 10. Séries trompeuses et malchanceux
  const lecture = (p: any) => p.serie === 'flatteuse' ? `${p.p3_l10} % à 3 points sur 10 matchs contre ${p.p3_reg} % de normale : probabilité retenue plus basse (${p.mu.pts} pts attendus).` : `${p.p3_l10} % à 3 points sur 10 matchs malgré le volume, normale ${p.p3_reg} % : retour probable (${p.mu.pts} pts attendus).`;
  const pieges = players.filter(p => open(p) && p.serie === 'flatteuse').slice(0, 6).map(p => ({ nom: p.nom, equipe: p.equipe, match: p.match, lecture: lecture(p), p20: p.p_20, p30: p.p_30 }));
  const relance = players.filter(p => open(p) && p.serie === 'malchanceux').slice(0, 6).map(p => ({ nom: p.nom, equipe: p.equipe, match: p.match, lecture: lecture(p), p20: p.p_20, p30: p.p_30 }));

  // ---- 11. Totaux & spreads (match et période les plus sûrs)
  const liste = games.map(g => {
    const cands: any[] = [];
    const sp = g.marches?.spread, to = g.marches?.total;
    if (to) { cands.push({ kind: 'over', line: to.line, label: `Plus de ${to.line} points`, prob: to.p_over, cote: to.cote_over }); cands.push({ kind: 'under', line: to.line, label: `Moins de ${to.line} points`, prob: to.p_under, cote: to.cote_under }); }
    if (sp) { cands.push({ kind: 'spread', team: g.domicile, line: sp.line_dom, label: `${g.domicile} ${sp.line_dom > 0 ? '+' : ''}${sp.line_dom}`, prob: sp.p_dom, cote: sp.cote_dom }); cands.push({ kind: 'spread', team: g.exterieur, line: sp.line_ext, label: `${g.exterieur} ${sp.line_ext > 0 ? '+' : ''}${sp.line_ext}`, prob: sp.p_ext, cote: sp.cote_ext }); }
    const best = cands.sort((a, b) => b.prob - a.prob)[0] || null;
    const segBest = g.segments.flatMap((s: any) => [{ ...s, team: g.domicile, p: s.p_dom }, { ...s, team: g.exterieur, p: s.p_ext }]).sort((a: any, b: any) => b.p - a.p)[0];
    return { game_id: g.game_id, match: `${g.exterieur} @ ${g.domicile}`, heure: g.debut_paris, commence: g.commence, total: g.total, ecart_dom: g.ecart_dom, dom: g.domicile, ext: g.exterieur,
      ligne_total: to?.line ?? null, p_over: to?.p_over ?? null, p_under: to?.p_under ?? null, ligne_spread: sp?.line_dom ?? null, p_cover_dom: sp?.p_dom ?? null, p_cover_ext: sp?.p_ext ?? null,
      segments: g.segments, meilleur: best ? { ...best, cote_juste: fairOdds(best.prob), cote_min: r3(1.05 / best.prob, 2) } : null, periode: segBest ? { seg: segBest.seg, label: segBest.label, team: segBest.team, prob: segBest.p } : null };
  });
  const openL = liste.filter(x => !x.commence);
  const bm = openL.filter(x => x.meilleur).sort((a, b) => b.meilleur.prob - a.meilleur.prob)[0];
  const bp = openL.filter(x => x.periode).sort((a, b) => b.periode.prob - a.periode.prob)[0];
  const why = (x: any) => { const g = G(x.game_id); return [`Points attendus : ${g.exterieur} ${g.pts_ext} – ${g.domicile} ${g.pts_dom} (total ${g.total}, écart ${g.ecart_dom > 0 ? '+' : ''}${g.ecart_dom} pour ${g.domicile}).`, ...g.base.slice(0, 3)]; };
  const totaux = {
    liste,
    match: bm ? { game_id: bm.game_id, match: bm.match, label: bm.meilleur.label, prob: bm.meilleur.prob, cote: bm.meilleur.cote, cote_juste: bm.meilleur.cote_juste, cote_min: bm.meilleur.cote_min, raisons: why(bm), leg: { kind: bm.meilleur.kind, team: bm.meilleur.team, line: bm.meilleur.line, game_id: bm.game_id } } : null,
    periode: bp ? { game_id: bp.game_id, match: bp.match, label: `${bp.periode.team} gagne la ${bp.periode.label}`, prob: bp.periode.prob, cote_juste: fairOdds(bp.periode.prob), cote_min: r3(1.05 / bp.periode.prob, 2), raisons: why(bp), leg: { kind: 'seg', team: bp.periode.team, seg: bp.periode.seg, game_id: bp.game_id } } : null,
    fiab: ['Totaux & spreads', 'Totaux : match le plus sûr', 'Totaux : période la plus sûre'].map(t => { const g = (db.predictions || []).filter((p: any) => p.type === t && (p.resultat === 0 || p.resultat === 1)); return { type: t, n: g.length, prevu: g.length ? r3(g.reduce((s: number, p: any) => s + p.prob, 0) / g.length) : null, reel: g.length ? r3(g.filter((p: any) => p.resultat === 1).length / g.length) : null }; }),
  };
  for (const x of openL) if (x.meilleur) preds.push({ type: 'Totaux & spreads', game_id: x.game_id, selection: `${x.match} : ${x.meilleur.label}`, prob: x.meilleur.prob, cote: x.meilleur.cote, legs: [{ kind: x.meilleur.kind, team: x.meilleur.team, line: x.meilleur.line, game_id: x.game_id }] });
  if (totaux.match) preds.push({ type: 'Totaux : match le plus sûr', game_id: totaux.match.game_id, selection: `${totaux.match.match} : ${totaux.match.label}`, prob: totaux.match.prob, cote: totaux.match.cote, legs: [totaux.match.leg] });
  if (totaux.periode) preds.push({ type: 'Totaux : période la plus sûre', game_id: totaux.periode.game_id, selection: `${totaux.periode.match} : ${totaux.periode.label}`, prob: totaux.periode.prob, legs: [totaux.periode.leg] });

  return { points, safe, buteur, cote2, cote2j, fun, autres: { paris: autres, n_classes: tb?.n_classes || 0, seuil_chance: r3(tb?.seuil_chance, 2) }, olbg, top5: { parieurs: top5, n_classes: tb?.n_classes || 0, seuil_chance: r3(tb?.seuil_chance, 2) }, accord, accord_info: { n: ln, gagnes: lw, z: r3(lz, 2), poids: Math.round(poids * 100) },
    objectif80, trente, equipes, pieges, relance, totaux, preds, bilan: null as any, provisoire: games.some(g => !g.cinq) };
}
const pick = (l: any) => ({ kind: l.kind, team: l.team ?? null, line: l.line ?? null, stat: l.stat ?? null, k: l.k ?? null, seg: l.seg ?? null, player_id: l.player_id ?? null, game_id: l.game_id, label: l.label, match: l.match, cote: l.cote ?? null });

export function bilanSelection(db: any) {
  const out: any = {};
  for (const [k, typ] of [['points', 'Sélection points'], ['equipes', 'Sélection équipe'], ['objectif80', 'Objectif 80 %'], ['trente', 'Sélection 30+ points'], ['buteur', 'Meilleur marqueur du soir'], ['safe', 'Pari safe du jour'],
    ['cote2', 'Cote 2+'], ['fun', 'Pari fun'], ['autres', 'Pari parieur Covers'], ['top5', 'Pari top Covers'], ['olbg_top', 'Consensus OLBG'], ['olbg_best', 'Pari tipster OLBG'], ['tot_match', 'Totaux : match le plus sûr'], ['tot_periode', 'Totaux : période la plus sûre'], ['totaux', 'Totaux & spreads']] as const) {
    const g = db.predictions.filter((p: any) => p.type.startsWith(typ) && (p.resultat === 0 || p.resultat === 1));
    const sur = g.filter((p: any) => p.niveau === 'Choix sûr');
    out[k] = { n: g.length, gagnes: g.filter((p: any) => p.resultat === 1).length, sur_n: sur.length, sur_gagnes: sur.filter((p: any) => p.resultat === 1).length };
  }
  return out;
}

export function parisSuivis(db: any) {
  const T = ['Pari safe du jour', 'Cote 2+', 'Pari fun Doubles / 30+ points', 'Pari fun Victoire + joueur', 'Pari fun Mélange', 'Pari fun Méga points', 'Pari parieur Covers', 'Pari top Covers', 'Consensus OLBG', 'Pari tipster OLBG', 'Totaux : match le plus sûr', 'Totaux : période la plus sûre'];
  const list = db.predictions.filter((p: any) => T.includes(p.type)).slice(-300).reverse();
  const profit = (p: any) => p.resultat === 1 ? (p.cote || (p.prob ? 1 / p.prob : 1)) - 1 : p.resultat === 0 ? -1 : 0;
  const recap = ['Tous', ...T].map(t => {
    const xs = list.filter((p: any) => t === 'Tous' || p.type === t), ev = xs.filter((p: any) => p.resultat === 0 || p.resultat === 1);
    const g = ev.reduce((s: number, p: any) => s + profit(p), 0);
    return { type: t, evalues: ev.length, gagnes: ev.filter((p: any) => p.resultat === 1).length, attente: xs.filter((p: any) => p.resultat == null).length, gain: r3(g, 2), rendement: ev.length ? r3(g / ev.length) : null };
  });
  return { recap, paris: list.map((p: any) => ({ type: p.type, date: p.date, selection: p.selection, cote: p.cote ?? (p.prob ? r3(1 / p.prob, 2) : null), prob: p.prob, resultat: p.resultat, gain: r3(profit(p), 2),
    legs: (p.legs || []).map((l: any, i: number) => ({ label: l.label || p.selection, match: l.match || null, res: p.legs_res?.[i] ?? null })) })) };
}
