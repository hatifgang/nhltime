// Stockage : Netlify Blobs en ligne, dossier local pour les tests (NHL_LOCAL_STORE=chemin).
import { getStore } from '@netlify/blobs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface KV {
  getJSON(key: string): Promise<any>;
  setJSON(key: string, value: any): Promise<void>;
  del(key: string): Promise<void>;
}

export function kv(name = 'nhl'): KV {
  const local = process.env.NHL_LOCAL_STORE;
  if (local) {
    const pre = name === 'nhl' ? '' : name + '_';
    const f = (k: string) => path.join(local, pre + k.replace(/[^\w.-]/g, '_') + '.json');
    return {
      async getJSON(k) { try { return JSON.parse(await fs.readFile(f(k), 'utf8')); } catch { return null; } },
      async setJSON(k, v) { await fs.mkdir(local, { recursive: true }); await fs.writeFile(f(k), JSON.stringify(v)); },
      async del(k) { await fs.rm(f(k), { force: true }); },
    };
  }
  const s = getStore({ name, consistency: 'strong' });
  return {
    async getJSON(k) { return await s.get(k, { type: 'json' }); },
    async setJSON(k, v) { await s.setJSON(k, v); },
    async del(k) { await s.delete(k); },
  };
}

export const emptyDb = () => ({ results: [], teams: [], players: [], injuries: [], predictions: [], odds: [], runs: [], journal: [] as any[] });
