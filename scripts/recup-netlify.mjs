// Récupère les anciennes stats stockées dans Netlify Blobs (ancien site nhl-paris-mathis) vers le dossier data/.
// Usage (PowerShell) :  $env:NETLIFY_TOKEN="ton_jeton"; node scripts/recup-netlify.mjs
// Le jeton n'est lu que dans la variable d'environnement : il n'est écrit nulle part.
import { getStore } from '@netlify/blobs';
import fs from 'node:fs';
import path from 'node:path';

const token = process.env.NETLIFY_TOKEN;
if (!token) { console.error('Variable NETLIFY_TOKEN absente.'); process.exit(1); }
const siteID = '4a112ee1-cf70-4401-b3ac-5facb752e2b4';
const out = path.resolve('data');
fs.mkdirSync(out, { recursive: true });
let ok = 0, ko = 0;
for (const name of ['nhl', 'nba', 'europe']) {
  const s = getStore({ name, siteID, token });
  let keys = ['db', 'latest', 'params', 'mescotes'];
  try { const l = await s.list(); if (l?.blobs?.length) keys = l.blobs.map(b => b.key); } catch (e) { console.log(`liste ${name} impossible (${e.message}), clés habituelles`); }
  for (const k of keys) {
    if (k === 'lock') continue;
    try {
      const v = await s.get(k, { type: 'json' });
      if (v == null) continue;
      const f = path.join(out, (name === 'nhl' ? '' : name + '_') + k.replace(/[^\w.-]/g, '_') + '.json');
      fs.writeFileSync(f, JSON.stringify(v));
      console.log(`ok  ${name}/${k}  ${(fs.statSync(f).size / 1024).toFixed(0)} Ko`); ok++;
    } catch (e) { console.log(`ÉCHEC ${name}/${k} : ${e.message}`); ko++; }
  }
}
console.log(`\n${ok} fichier(s) récupéré(s), ${ko} échec(s). Dossier : ${out}`);
