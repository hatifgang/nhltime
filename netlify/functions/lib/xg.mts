// Buts attendus (xG) maison : probabilité qu'un tir devienne un but, d'après sa position et son contexte,
// calculée sur le play-by-play officiel de la LNH. Régression logistique entraînée hors ligne
// (scratchpad : xg train, saison 2025-26, tirs non bloqués, filet désert exclu). Coefficients figés ci-dessous.

/** Événement compact : [type, période, type de période, secondes, situationCode, côté défendu par le domicile, x, y, zone, type de tir, équipe] */
export type Ev = [string, number, string, number, string | null, string | null, number | null, number | null, string | null, string | null, number | null];

export function compactPbp(d: any): { H: number; A: number; ev: Ev[] } {
  const ev: Ev[] = [];
  for (const p of d?.plays || []) {
    const det = p.details || {}, pd = p.periodDescriptor || {};
    const [mm, ss] = String(p.timeInPeriod || '0:0').split(':').map(Number);
    ev.push([String(p.typeDescKey || '').slice(0, 4), pd.number, pd.periodType, (mm || 0) * 60 + (ss || 0), p.situationCode ?? null, p.homeTeamDefendingSide ?? null,
      det.xCoord ?? null, det.yCoord ?? null, det.zoneCode ?? null, det.shotType ?? null, det.eventOwnerTeamId ?? null]);
  }
  return { H: d?.homeTeam?.id, A: d?.awayTeam?.id, ev };
}

export const XG_NAMES = ['const', 'dist', 'lndist', 'angle', 'angle2', 'distangle', 'wrist', 'snap', 'slap', 'backhand', 'tip', 'deflected', 'wrap', 'rebound', 'rebound_dangle', 'rush', 'pp', 'sh', 'ot', 'behind', 'turnover', 'speed'];
const TYPES = ['wrist', 'snap', 'slap', 'backhand', 'tip-in', 'deflected', 'wrap-around'];
const UNBLOCKED = new Set(['shot', 'miss', 'goal']);   // 'shot'-on-goal, 'miss'ed-shot, 'goal' (4 premières lettres)

export interface Shot { team: number; home: boolean; goal: number; f: number[] }
/** Tirs non bloqués d'un match avec leurs caractéristiques (filet désert et tirs de fusillade exclus). */
export function shotFeatures(H: number, A: number, ev: Ev[]): Shot[] {
  const out: Shot[] = [];
  let prev: Ev | null = null, prevAng: number | null = null;
  for (const e of ev) {
    const [t, per, ptype, sec, sit, hside, x, y, , st, own] = e;
    if (ptype === 'SO') continue;
    if (UNBLOCKED.has(t) && x != null && y != null && own != null && (own === H || own === A)) {
      const home = own === H;
      // filet visé : le domicile attaque le côté opposé à celui qu'il défend
      let netX: number;
      if (hside === 'left' || hside === 'right') netX = (home ? (hside === 'left' ? 1 : -1) : (hside === 'left' ? -1 : 1)) * 89;
      else netX = (x >= 0 ? 1 : -1) * 89;
      const dx = Math.abs(netX - x), dist = Math.max(1, Math.hypot(dx, y)), angle = Math.atan2(Math.abs(y), dx) * 180 / Math.PI;
      // situation : chiffres = gardien extérieur, patineurs extérieur, patineurs domicile, gardien domicile
      const s = String(sit || '1551').padStart(4, '0');
      const ag = +s[0], as = +s[1], hs = +s[2], hg = +s[3];
      const oppGoalie = home ? ag : hg, mine = home ? hs : as, theirs = home ? as : hs;
      if (oppGoalie === 0) { prev = e; continue; }   // filet désert : exclu
      const sameP = prev && prev[1] === per, gap = sameP ? sec - prev![3] : 99;
      const rebound = sameP && gap <= 3 && UNBLOCKED.has(prev![0]) && prev![10] === own ? 1 : 0;
      const px = prev?.[6];
      const rush = sameP && gap <= 4 && px != null && !rebound && (Math.abs(px) < 25 || Math.sign(px) !== Math.sign(x)) ? 1 : 0;
      const dAng = rebound && prevAng != null ? Math.abs(angle - prevAng) / 10 : 0;
      const ty = TYPES.indexOf(st || '');
      const f = [1, dist / 10, Math.log(dist), angle / 10, (angle / 10) ** 2, dist * angle / 1000,
        ...TYPES.map((_, i) => +(ty === i)), rebound, dAng, rush, +(mine > theirs), +(mine < theirs), +(per > 3),
        +(Math.abs(x) > 89 && Math.sign(x) === Math.sign(netX)),                                     // derrière le but
        +(sameP && gap <= 5 && (prev![0] === 'take' || prev![0] === 'give')),                           // juste après une perte de palet
        sameP && gap <= 4 && px != null && prev![7] != null ? Math.min(10, Math.hypot(x - px, y - prev![7]!) / Math.max(1, gap) / 10) : 0];   // vitesse de l'action
      out.push({ team: own, home, goal: t === 'goal' ? 1 : 0, f });
      prevAng = angle;
    } else if (UNBLOCKED.has(t) || t === 'bloc') prevAng = null;
    prev = e;
  }
  return out;
}

// Coefficients appris : 111 099 tirs de 2025-26 ; validé sur 41 362 tirs de 2026-27 jamais vus (AUC 0,754, 0,97 but attendu par but réel)
export const XG_COEF: number[] = [-1.4001, -0.4802, 0.1057, 0.1934, -0.0349, -0.546, 0.1306, 0.4307, 0.563, -0.2832, -0.8305, -0.3142, -0.7877, -0.0712, 0.1115, 0.0082, 0.1895, 0.1668, 0.2832, -0.7113, 0.4468, -0.4009];

export const xgShot = (f: number[], c = XG_COEF) => { let z = 0; for (let i = 0; i < f.length; i++) z += c[i] * f[i]; return 1 / (1 + Math.exp(-z)); };

/** xG d'un match pour chaque équipe (toutes situations, hors filet désert). */
export function gameXg(d: any) {
  const { H, A, ev } = compactPbp(d);
  const sh = shotFeatures(H, A, ev);
  let h = 0, a = 0;
  for (const s of sh) { const p = xgShot(s.f); if (s.home) h += p; else a += p; }
  return { H, A, xg_h: Math.round(h * 100) / 100, xg_a: Math.round(a * 100) / 100, tirs: sh.length };
}
