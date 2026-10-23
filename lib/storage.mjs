// Storage backed by Netlify Blobs in production, or a local folder for development/testing
// (set LOCAL_BLOBS_DIR). Sensitive records are encrypted before they are written.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { encryptJSON, decryptJSON, encryptBytes, decryptBytes } from './crypto.mjs';

const STORE_NAME = 'awa-redirection';

function localStore(dir) {
  const file = (key) => path.join(dir, encodeURIComponent(key));
  return {
    async getBytes(key) {
      try { return new Uint8Array(await fs.readFile(file(key))); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async setBytes(key, bytes) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file(key), Buffer.from(bytes));
    },
    async delete(key) {
      try { await fs.unlink(file(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    },
    async list(prefix) {
      let names = [];
      try { names = await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      return names.map(decodeURIComponent).filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

async function netlifyStore() {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  return {
    async getBytes(key) {
      const ab = await store.get(key, { type: 'arrayBuffer' });
      return ab ? new Uint8Array(ab) : null;
    },
    async setBytes(key, bytes) {
      const u8 = Uint8Array.from(bytes);
      await store.set(key, u8.buffer);
    },
    async delete(key) { await store.delete(key); },
    async list(prefix) {
      const { blobs } = await store.list({ prefix });
      return blobs.map((b) => b.key).sort();
    },
  };
}

export async function openStore(secret) {
  const raw = process.env.LOCAL_BLOBS_DIR ? localStore(process.env.LOCAL_BLOBS_DIR) : await netlifyStore();
  const textJSON = {
    async get(key) {
      const b = await raw.getBytes(key);
      return b ? JSON.parse(Buffer.from(b).toString('utf8')) : null;
    },
    async set(key, value) { await raw.setBytes(key, Buffer.from(JSON.stringify(value), 'utf8')); },
  };
  return {
    raw,
    // Plain JSON (non-sensitive: form templates, rate-limit counters)
    getJSON: textJSON.get,
    setJSON: textJSON.set,
    // Encrypted JSON (rosters, submissions)
    async getSecretJSON(key) {
      const b = await raw.getBytes(key);
      return b ? decryptJSON(secret, b) : null;
    },
    async setSecretJSON(key, value) { await raw.setBytes(key, encryptJSON(secret, value)); },
    // Encrypted bytes (signed PDFs)
    async getSecretBytes(key) {
      const b = await raw.getBytes(key);
      return b ? new Uint8Array(decryptBytes(secret, b)) : null;
    },
    async setSecretBytes(key, bytes) { await raw.setBytes(key, encryptBytes(secret, bytes)); },
    delete: (key) => raw.delete(key),
    list: (prefix) => raw.list(prefix),
  };
}

export const keys = {
  company: (slug) => `companies/${slug}`,
  companiesPrefix: 'companies/',
  roster: (slug) => `rosters/${slug}`,
  submission: (slug, id) => `submissions/${slug}/${id}`,
  submissionsPrefix: (slug) => `submissions/${slug}/`,
  pdf: (slug, id) => `pdfs/${slug}/${id}`,
  rateLimit: (scope, id) => `ratelimit/${scope}/${id}`,
};
