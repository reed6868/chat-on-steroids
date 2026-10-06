import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

const gate = vi.hoisted(() => ({ actions: true, enabled: true }));
const browser = vi.hoisted(() => ({ infer: vi.fn() }));

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
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), controlApi: { enabled: gate.enabled, allowActions: gate.actions } }) };
});
vi.mock('../src/main/browser-inference.js', () => ({
  inferWithChatGPTBrowser: browser.infer
}));
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

let dir = '';
let port = 0;
let token = '';

const requestBody = () => ({
  model: 'gpt-5.6-sol',
  stream: true,
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello.' }] }],
  tools: [],
  tool_choice: 'auto',
  parallel_tool_calls: false,
  reasoning: { effort: 'high' },
  store: false,
  include: []
});

async function call(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  const rawBody = body === undefined ? undefined : JSON.stringify(body);
  const requestHeaders: Record<string, string> = {
    authorization: 'Bearer ' + token,
    ...headers
  };
  if (rawBody !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    requestHeaders['content-length'] = String(Buffer.byteLength(rawBody));
  }
  return new Promise<{ status: number; raw: string; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: requestHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = raw;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { /* SSE/plain text */ }
        resolve({ status: res.statusCode ?? 0, raw, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(rawBody);
  });
}

async function restart(): Promise<void> {
  await controlApi.stopControlApi();
  await controlApi.startControlApi();
  const endpoint = JSON.parse(await fs.readFile(path.join(dir, 'control-api', 'endpoint.json'), 'utf8'));
  port = endpoint.port;
  token = (await fs.readFile(path.join(dir, 'control-api', 'token'), 'utf8')).trim();
}

beforeAll(async () => {
  dir = await makeTempDir('clf-codex-provider-');
  initConfigPath(dir);
  controlApi.initControlApiPath(dir);
  await restart();
});

beforeEach(() => {
  gate.enabled = true;
  gate.actions = true;
  browser.infer.mockReset();
  browser.infer.mockResolvedValue(JSON.stringify({ type: 'message', text: 'hello' }));
});

afterAll(async () => {
  await controlApi.shutdownControlApi();
  await removeTempDir(dir);
});

describe('Codex Responses route', () => {
  it('is action-gated and advertised without changing the existing read surface', async () => {
    gate.actions = false;
    const refused = await call('POST', '/v1/responses', requestBody());
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: 'actions_disabled' });
    expect(browser.infer).not.toHaveBeenCalled();

    const health = await call('GET', '/v1/health');
    expect(health.body.actions).toEqual({
      enabled: false,
      routes: ['POST /v1/inputs', 'POST /v1/inputs/{id}/cancel', 'POST /v1/responses']
    });
    expect(health.body.routes).not.toContain('/v1/responses');
  });

  it('returns Responses SSE from ChatGPT Web through the existing loopback authentication boundary', async () => {
    const response = await call('POST', '/v1/responses', requestBody());
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.raw).toContain('event: response.created');
    expect(response.raw).toContain('event: response.output_item.done');
    expect(response.raw).toContain('event: response.completed');
    expect(browser.infer).toHaveBeenCalledTimes(1);

    expect((await call('POST', '/v1/responses', requestBody(), { authorization: '' })).status).toBe(401);
    expect((await call('POST', '/v1/responses', requestBody(), { origin: 'https://chatgpt.com' })).status).toBe(403);
    expect((await call('POST', '/v1/responses', requestBody(), { host: 'attacker.example' })).status).toBe(403);
  });

  it('returns a bounded JSON error for unsupported Responses requests instead of falling back elsewhere', async () => {
    const response = await call('POST', '/v1/responses', { ...requestBody(), stream: false });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'unsupported_request' });
    expect(browser.infer).not.toHaveBeenCalled();
  });
});
