import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createStaticRoutesRuntime } from './static-routes-runtime.js';

const createRuntime = (distPath) => createStaticRoutesRuntime({
  fs: distPath ? { existsSync: () => true } : { existsSync: () => false },
  path,
  process: { env: distPath ? { OPENCHAMBER_DIST_DIR: distPath } : {} },
  __dirname: '/server',
  express,
  resolveProjectDirectory: () => '',
  buildOpenCodeUrl: () => '',
  getOpenCodeAuthHeaders: () => ({}),
  readSettingsFromDiskMigrated: async () => ({}),
  normalizePwaAppName: (value) => value,
  normalizePwaOrientation: (value) => value,
});

describe('static routes runtime', () => {
  it('returns API-only HTML fallback for browser UI routes', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const response = await request(app).get('/sessions/abc').set('Accept', 'text/html');

    expect(response.status).toBe(200);
    expect(response.text).toContain('OpenChamber is running in headless mode');
    expect(response.text).toContain('Open it from the OpenChamber desktop or mobile app');
    expect(response.text).toContain('openchamber connect-url --help');
    expect(response.text).toContain('Copy command');
  });

  it('returns API-only info JSON for JSON clients', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const response = await request(app).get('/sessions/abc').set('Accept', 'application/json');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      mode: 'api-only',
      message: 'OpenChamber is running in API-only mode',
    });
  });

  it('does not intercept API, auth, or health routes in API-only mode', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const api = await request(app).get('/api/version');
    const auth = await request(app).get('/auth/session');
    const health = await request(app).get('/health');

    expect(api.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber is running in API-only mode' });
    expect(auth.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber is running in API-only mode' });
    expect(health.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber is running in API-only mode' });
  });

  it('does not cache navigation HTML while preserving hashed asset caching', async () => {
    const distPath = await mkdtemp(path.join(tmpdir(), 'openchamber-static-routes-'));
    try {
      await writeFile(path.join(distPath, 'index.html'), '<!doctype html><title>fixture</title>');
      await writeFile(path.join(distPath, 'mobile.html'), '<!doctype html><title>mobile fixture</title>');
      await writeFile(path.join(distPath, 'mini-chat.html'), '<!doctype html><title>mini chat fixture</title>');
      await writeFile(path.join(distPath, 'sw.js'), 'self.addEventListener("fetch", () => {});');
      await mkdir(path.join(distPath, 'assets'));
      await writeFile(path.join(distPath, 'assets', 'main.123.js'), 'console.log("fixture");');

      const app = express();
      createRuntime(distPath).registerStaticRoutes(app);

      for (const route of ['/', '/index.html', '/mobile.html', '/mini-chat.html', '/sessions/abc']) {
        const response = await request(app).get(route);
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
      }

      const serviceWorker = await request(app).get('/sw.js');
      expect(serviceWorker.status).toBe(200);
      expect(serviceWorker.headers['cache-control']).toBe('no-store');

      const asset = await request(app).get('/assets/main.123.js');
      expect(asset.status).toBe(200);
      expect(asset.headers['cache-control']).not.toBe('no-store');
    } finally {
      await rm(distPath, { recursive: true, force: true });
    }
  });
});
