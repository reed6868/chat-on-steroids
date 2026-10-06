import { describe, expect, it, vi } from 'vitest';
import {
  CHATGPT_PLAN_RESOURCE,
  CHATGPT_PLAN_SCOPES,
  ChatgptPlanAuth,
  type ChatgptPlanCredential,
  type ChatgptPlanAuthStore
} from '../src/main/chatgpt-plan-auth.js';
import { AgentRuntimeRegistry } from '../src/main/runtime/registry.js';
import { ChatgptPlanCodexRuntime } from '../src/main/runtime/chatgpt-plan-codex-runtime.js';
import { RuntimeExecutionBroker } from '../src/main/runtime/agent-broker.js';
import {
  CodexAppServerRuntime,
  type CodexAppServerClient,
  type CodexAppServerNotification
} from '../src/main/runtime/codex-app-server-runtime.js';

class MemoryStore implements ChatgptPlanAuthStore {
  hostId: string | null = null;
  credential: ChatgptPlanCredential | null = null;
  async readHostId(): Promise<string | null> { return this.hostId; }
  async writeHostId(value: string): Promise<void> { this.hostId = value; }
  async readCredential(): Promise<ChatgptPlanCredential | null> { return this.credential; }
  async writeCredential(value: ChatgptPlanCredential | null): Promise<void> { this.credential = value; }
}

const validated = {
  issuer: 'https://auth.openai.com',
  subject: 'subject-1',
  email: 'user@example.com'
};

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    id_token: 'id-1',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: CHATGPT_PLAN_SCOPES.join(' '),
    ...overrides
  };
}

describe('ChatGPT Plan OAuth', () => {
  it('builds the official dynamic-client authorization request without secrets in the URL', async () => {
    const store = new MemoryStore();
    const auth = new ChatgptPlanAuth({
      store,
      fetch: vi.fn(),
      validateIdToken: vi.fn(),
      now: () => 1_000_000
    });

    const attempt = await auth.createAuthorizationAttempt('http://127.0.0.1:1455/auth/callback');

    expect(attempt.url.origin + attempt.url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(attempt.url.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(attempt.url.searchParams.get('agent_name_hint')).toBe('Chat On Steroids');
    expect(attempt.url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    expect(attempt.url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
    expect(CHATGPT_PLAN_RESOURCE).toBe('https://api.openai.com/v1');
    expect(attempt.url.searchParams.get('resource')).toBe('https://api.openai.com/v1');
    expect(attempt.url.searchParams.get('scope')?.split(' ').sort()).toEqual([...CHATGPT_PLAN_SCOPES].sort());
    expect(attempt.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(attempt.url.href).not.toContain('access-');
    expect(attempt.url.href).not.toContain('refresh-');
    expect(store.hostId).toBe(attempt.hostId);
  });

  it('exchanges an issued dynamic client, validates identity, and stores the granted plan credential', async () => {
    const store = new MemoryStore();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(tokenResponse()), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    const validate = vi.fn(async () => validated);
    const auth = new ChatgptPlanAuth({ store, fetch: fetcher as typeof fetch, validateIdToken: validate, now: () => 2_000_000 });
    const attempt = await auth.createAuthorizationAttempt('http://127.0.0.1:1455/auth/callback');

    await auth.completeAuthorizationAttempt(new URLSearchParams({
      code: 'code-1',
      state: attempt.state,
      client_id: 'oaiapp_issued'
    }), attempt);

    expect(fetcher).toHaveBeenCalledOnce();
    const [, init] = fetcher.mock.calls[0]!;
    expect(String(init?.body)).toContain('client_id=oaiapp_issued');
    expect(String(init?.body)).toContain('grant_type=authorization_code');
    expect(String(init?.body)).toContain('resource=' + encodeURIComponent(CHATGPT_PLAN_RESOURCE));
    expect(validate).toHaveBeenCalledWith('id-1', expect.objectContaining({
      clientId: 'oaiapp_issued',
      nonce: attempt.nonce
    }));
    expect(store.credential).toEqual(expect.objectContaining({
      clientId: 'oaiapp_issued',
      subject: 'subject-1',
      email: 'user@example.com',
      accessToken: 'access-1',
      refreshToken: 'refresh-1'
    }));
    expect(await auth.status()).toEqual(expect.objectContaining({ signedIn: true, planEnabled: true }));
  });


  it('reauthorizes a saved registration with its issued client and retained account hints', async () => {
    const store = new MemoryStore();
    store.hostId = 'urn:uuid:host';
    store.credential = {
      issuer: 'https://auth.openai.com',
      subject: 'subject-1',
      email: 'user@example.com',
      clientId: 'oaiapp_issued',
      hostId: store.hostId,
      idToken: 'retained-id-token',
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      tokenType: 'Bearer',
      scopes: [...CHATGPT_PLAN_SCOPES],
      savedAt: 1_000_000,
      expiresAt: 1_010_000
    };
    const auth = new ChatgptPlanAuth({
      store,
      fetch: vi.fn(),
      validateIdToken: vi.fn(),
      now: () => 2_000_000
    });

    const attempt = await auth.createAuthorizationAttempt('http://127.0.0.1:1455/auth/callback');

    expect(attempt.url.searchParams.get('client_id')).toBe('oaiapp_issued');
    expect(attempt.url.searchParams.get('id_token_hint')).toBe('retained-id-token');
    expect(attempt.url.searchParams.get('login_hint')).toBe('user@example.com');
    expect(attempt.url.searchParams.has('agent_name_hint')).toBe(false);
  });

  it('revokes the renewable session before clearing local credentials on sign out', async () => {
    const store = new MemoryStore();
    store.hostId = 'urn:uuid:host';
    store.credential = {
      issuer: 'https://auth.openai.com',
      subject: 'subject-1',
      email: 'user@example.com',
      clientId: 'oaiapp_issued',
      hostId: store.hostId,
      idToken: 'id-old',
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      tokenType: 'Bearer',
      scopes: [...CHATGPT_PLAN_SCOPES],
      savedAt: 1_000_000,
      expiresAt: 2_000_000
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify({
          revocation_endpoint: 'https://auth.openai.com/oauth/revoke'
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://auth.openai.com/oauth/revoke') return new Response('', { status: 200 });
      throw new Error('unexpected request ' + url);
    });
    const auth = new ChatgptPlanAuth({
      store,
      fetch: fetcher as typeof fetch,
      validateIdToken: vi.fn(),
      now: () => 2_000_000
    });

    await auth.signOut();

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [, revokeInit] = fetcher.mock.calls[1]!;
    expect(String(revokeInit?.body)).toContain('token=refresh-old');
    expect(String(revokeInit?.body)).toContain('token_type_hint=refresh_token');
    expect(String(revokeInit?.body)).toContain('client_id=oaiapp_issued');
    expect(store.credential).toBeNull();
  });

  it('refreshes with the issued client id and atomically replaces the rotating refresh token', async () => {
    const store = new MemoryStore();
    store.hostId = 'urn:uuid:host';
    store.credential = {
      issuer: 'https://auth.openai.com',
      subject: 'subject-1',
      email: 'user@example.com',
      clientId: 'oaiapp_issued',
      hostId: store.hostId,
      idToken: 'id-old',
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      tokenType: 'Bearer',
      scopes: [...CHATGPT_PLAN_SCOPES],
      savedAt: 1_000_000,
      expiresAt: 1_010_000
    };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(tokenResponse({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      id_token: 'id-new'
    })), { status: 200, headers: { 'content-type': 'application/json' } }));
    const auth = new ChatgptPlanAuth({
      store,
      fetch: fetcher as typeof fetch,
      validateIdToken: vi.fn(async () => validated),
      now: () => 2_000_000
    });

    await expect(auth.accessToken()).resolves.toBe('access-new');

    const [, init] = fetcher.mock.calls[0]!;
    expect(String(init?.body)).toContain('grant_type=refresh_token');
    expect(String(init?.body)).toContain('client_id=oaiapp_issued');
    expect(String(init?.body)).toContain('refresh_token=refresh-old');
    expect(store.credential?.refreshToken).toBe('refresh-new');
    expect(store.credential?.accessToken).toBe('access-new');
  });
});

class FakeCodexClient implements CodexAppServerClient {
  listeners = new Set<(value: CodexAppServerNotification) => void>();
  async ready(): Promise<void> {}
  async startThread(): Promise<string> { return 'thread-e2e'; }
  async resumeThread(): Promise<void> {}
  async startTurn(): Promise<string> {
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        listener({ method: 'turn/started', params: { threadId: 'thread-e2e', turn: { id: 'turn-e2e' } } });
        listener({ method: 'item/agentMessage/delta', params: { threadId: 'thread-e2e', delta: 'COS_CODEX_E2E_OK' } });
        listener({ method: 'turn/completed', params: { threadId: 'thread-e2e', turn: { id: 'turn-e2e', status: 'completed' } } });
      }
    });
    return 'turn-e2e';
  }
  async interruptTurn(): Promise<void> {}
  onNotification(listener: (value: CodexAppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

class RestoredThreadCodexClient implements CodexAppServerClient {
  listeners = new Set<(value: CodexAppServerNotification) => void>();
  ready = vi.fn(async () => {});
  startThread = vi.fn(async () => 'unexpected-new-thread');
  resumeThread = vi.fn(async (_threadId: string) => {});
  startTurn = vi.fn(async () => 'turn-follow-up');
  interruptTurn = vi.fn(async () => {});
  dispose = vi.fn();

  onNotification(listener: (value: CodexAppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

describe('Codex runtime end-to-end gate', () => {
  it('resumes a restored durable Codex thread before its first follow-up in a fresh app-server process', async () => {
    const client = new RestoredThreadCodexClient();
    const runtime = new ChatgptPlanCodexRuntime(
      { accessToken: vi.fn(async () => 'access-1') } as any,
      'test-version',
      (() => client) as any
    );

    await runtime.send('thread-restored', { text: 'Continue after restart' });

    expect(client.resumeThread).toHaveBeenCalledWith('thread-restored');
    expect(client.startThread).not.toHaveBeenCalled();
    expect(client.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-restored',
      text: 'Continue after restart'
    }));
    runtime.dispose();
  });

  it('routes one owned agent execution through registry, Codex thread identity, and completion events', async () => {
    const registry = new AgentRuntimeRegistry();
    const runtime = new CodexAppServerRuntime(new FakeCodexClient());
    registry.register(runtime);
    const broker = new RuntimeExecutionBroker(registry);
    const events: unknown[] = [];
    runtime.onEvent(event => events.push(event));

    const binding = await broker.start({
      ownerId: 'runtime-owner-1',
      runtimeKind: 'codex-app-server',
      executionId: 'execution-1',
      input: 'Return the gate token',
      model: 'gpt-test',
      reasoningEffort: 'high',
      cwd: '/workspace'
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(binding).toEqual({
      ownerId: 'runtime-owner-1',
      runtimeKind: 'codex-app-server',
      sessionId: 'thread-e2e',
      executionId: 'execution-1'
    });
    expect(events).toContainEqual({ type: 'output-delta', sessionId: 'thread-e2e', text: 'COS_CODEX_E2E_OK' });
    expect(events).toContainEqual({ type: 'turn-completed', sessionId: 'thread-e2e' });
    expect(broker.snapshot().bindings).toEqual([binding]);
  });
});
