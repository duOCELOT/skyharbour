// Browser entry for the offline demo — bundled by `npm run build:demo` into
// client/demo/demo.js and loaded lazily by client/api.js when no game server
// answers (e.g. the GitHub Pages build). The whole harbour lives in one
// sql.js database, saved to localStorage after every write, so a pilot's
// progress survives reloads on this browser.
import initSqlJs from 'sql.js';
import type Database from 'better-sqlite3';
import { SqlJsFacade } from './sqljs.js';
import { createDemoBackend, type DemoRequest, type DemoResponse } from './backend.js';

const SAVE_KEY = 'sh-demo-db';

function load(): Uint8Array | undefined {
  try {
    const b64 = localStorage.getItem(SAVE_KEY);
    if (!b64) return undefined;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

function save(bytes: Uint8Array) {
  try {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    localStorage.setItem(SAVE_KEY, btoa(bin));
  } catch { /* private window / quota — the demo still plays, it just won't persist */ }
}

const SQL = await initSqlJs({ locateFile: (f: string) => new URL(f, import.meta.url).href });

function open() {
  const saved = load();
  try {
    const raw = new SQL.Database(saved);
    return { raw, backend: createDemoBackend(new SqlJsFacade(raw) as unknown as Database.Database) };
  } catch {
    // A corrupt or schema-incompatible save: start the harbour fresh.
    const raw = new SQL.Database();
    return { raw, backend: createDemoBackend(new SqlJsFacade(raw) as unknown as Database.Database) };
  }
}

const { raw, backend } = open();

export function request(req: DemoRequest): DemoResponse {
  const res = backend.handle(req);
  if (req.method !== 'GET') save(raw.export());
  return res;
}

export function reset() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
}
