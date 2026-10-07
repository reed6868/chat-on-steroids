import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

const gate = vi.hoisted(() => ({ actions: true, enabled: true, strict: true }));
const browser = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '', getVersion: vi.fn(() => '0.0.0'), getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
  nativeTheme: { themeSource: 'system' }
}));

vi.mock('../src/main/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/config.js')>();
  return { ...actual, getConfig: () => {
    const config = actual.getConfig();
    return {
      ...config,
      controlApi: { enabled: gate.enabled, allowActions: gate.actions },
      multiAgent: { ...config.multiAgent, strictChatAllowlist: gate.strict }
    };
  } };
});
vi.mock('../src/main/session/input.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/session/input.js')>();
  return { ...actual, requestBrowserDecision: browser.request };
});
vi.mock('../src/main/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/connection.js')>();
  return { ...actual, getStatus: () => ({ ...actual.getStatus(), state: 'connected' as const }) };
});
vi.mock('../src/main/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/bridge.js')>();
  return { ...actual, bridgeStatus: vi.fn(async () => ({ running: true, port: 8765, portOverridden: false, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: 'test', error: null })) };
});

const { initConfigPath } = await import('../src/main/config.js');
const controlApi = await import('../src/main/control-api.js');

let dir: string;
let port = 0;
let token = '';

async function restart(): Promise<void> {
  await controlApi.stopControlApi();
  await controlApi.startControlApi();
  const endpoint = JSON.parse(await fs.readFile(path.join(dir, 'control-api', 'endpoint.json'), 'utf8'));
  port = endpoint.port;
  token = (await fs.readFile(path.join(dir, 'control-api', 'token'), 'utf8')).trim();
}

function call(route: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        ...headers
      }
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-browser-inference-api-');
  initConfigPath(dir);
  controlApi.initControlApiPath(dir);
});

beforeEach(async () => {
  gate.enabled = true;
  gate.actions = true;
  gate.strict = true;
  browser.request.mockReset();
  controlApi.setBrowserInferenceDeadlineForTests();
  await restart();
});

afterAll(async () => {
  await controlApi.shutdownControlApi();
  await removeTempDir(dir);
});

it('publishes one additive action route and delegates inference to the existing browser transport', async () => {
  browser.request.mockResolvedValueOnce('answer from web');
  const response = await call('/v1/browser/infer', JSON.stringify({ prompt: 'solve', model: 'gpt-5.6-sol', reasoningEffort: 'high' }));
  expect(response).toEqual({ status: 200, body: { text: 'answer from web' } });
  expect(browser.request).toHaveBeenCalledTimes(1);

  const health = await new Promise<any>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/health', headers: { authorization: 'Bearer ' + token } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
    req.end();
  });
  expect(health.actions.routes).toContain('POST /v1/browser/infer');
});

it('uses the existing action consent gate before reading or dispatching inference', async () => {
  gate.actions = false;
  const response = await call('/v1/browser/infer', JSON.stringify({ prompt: 'must not run' }));
  expect(response.status).toBe(403);
  expect(response.body).toEqual({ error: 'actions_disabled' });
  expect(browser.request).not.toHaveBeenCalled();
});

it('fails closed for invalid JSON, query strings, invalid request fields, and browser failures', async () => {
  expect((await call('/v1/browser/infer', '{')).status).toBe(400);
  expect((await call('/v1/browser/infer?x=1', JSON.stringify({ prompt: 'x' }))).status).toBe(400);
  expect(await call('/v1/browser/infer', JSON.stringify({ prompt: '', extra: true }))).toEqual({
    status: 400,
    body: { error: 'invalid_request' }
  });

  browser.request.mockRejectedValueOnce(new Error('goal_browser_busy'));
  expect(await call('/v1/browser/infer', JSON.stringify({ prompt: 'busy' }))).toEqual({
    status: 503,
    body: { error: 'browser_busy' }
  });

  browser.request.mockRejectedValueOnce(new Error('goal_browser_send_unconfirmed'));
  expect(await call('/v1/browser/infer', JSON.stringify({ prompt: 'uncertain' }))).toEqual({
    status: 502,
    body: { error: 'browser_delivery_unconfirmed' }
  });
});

it('aborts a bounded inference instead of leaving an ownerless browser turn running', async () => {
  browser.request.mockImplementationOnce((_text: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('goal_browser_cancelled')), { once: true });
  }));
  controlApi.setBrowserInferenceDeadlineForTests(10);
  const response = await call('/v1/browser/infer', JSON.stringify({ prompt: 'wait forever' }));
  expect(response).toEqual({ status: 504, body: { error: 'browser_timeout' } });
  expect(browser.request).toHaveBeenCalledTimes(1);
});


it('fails closed when the temporary browser model is not fenced from COS tools', async () => {
  gate.strict = false;
  const response = await call('/v1/browser/infer', JSON.stringify({ prompt: 'must stay inference-only' }));
  expect(response).toEqual({ status: 409, body: { error: 'browser_tools_not_fenced' } });
  expect(browser.request).not.toHaveBeenCalled();
});
