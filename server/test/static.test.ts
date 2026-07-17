import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildApp } from '../src/app.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  app = buildApp({ staticRoot: repoRoot });
});

describe('static console', () => {
  it('serves index.html at /app/ without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SKY HARBOUR');
  });

  it('redirects / to /app/ without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/app/');
  });

  it('still guards the API with the wallet header', async () => {
    const res = await app.inject({ method: 'GET', url: '/balances' });
    expect(res.statusCode).toBe(401);
  });

  it('API works unchanged next to static', async () => {
    const res = await app.inject({ method: 'POST', url: '/login', headers: { 'x-wallet': 'alice' } });
    expect(res.statusCode).toBe(200);
  });

  it('without staticRoot the app behaves as before', async () => {
    const bare = buildApp();
    const res = await bare.inject({ method: 'GET', url: '/app/' });
    expect(res.statusCode).toBe(401); // auth hook still owns unknown routes
  });

  it('does not serve the ledger database through the static route', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/server/skyharbour.db' });
    expect(res.statusCode).not.toBe(200);
  });

  it('does not serve server source files through the static route', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/server/src/app.ts' });
    expect(res.statusCode).not.toBe(200);
  });

  it('does not serve dotfiles like .git/config through the static route', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/.git/config' });
    expect(res.statusCode).not.toBe(200);
  });

  it('rejects encoded path traversal attempts', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/..%2Fserver%2Fsrc%2Fapp.ts' });
    expect(res.statusCode).not.toBe(200);
  });

  it('rejects literal path traversal attempts', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/../server/src/app.ts' });
    expect(res.statusCode).not.toBe(200);
  });

  it('still serves allowlisted image assets at /app/img/', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/img/firerune.png' });
    expect(res.statusCode).toBe(200);
  });

  it('still serves allowlisted styles.css at /app/', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/styles.css' });
    expect(res.statusCode).toBe(200);
  });

  it('does not treat /appeal as the unauthenticated static bypass', async () => {
    const res = await app.inject({ method: 'GET', url: '/appeal' });
    expect(res.statusCode).toBe(401);
  });
});
