import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntime,
  RuntimeEventListener,
  RuntimeInput,
  RuntimeSession,
  RuntimeStartOptions
} from '../src/main/runtime/agent-runtime.js';
import {
  RuntimeExecutionBroker,
  type RuntimeExecutionRequest
} from '../src/main/runtime/agent-broker.js';
import { AgentRuntimeRegistry } from '../src/main/runtime/registry.js';

class FakeRuntime implements AgentRuntime {
  readonly listeners = new Set<RuntimeEventListener>();
  readonly start = vi.fn(async (options: RuntimeStartOptions): Promise<RuntimeSession> => ({
    id: `${this.kind}-session`,
    runtime: this.kind,
    executionId: options.executionId
  }));
  readonly send = vi.fn(async (_sessionId: string, _input: RuntimeInput) => {});
  readonly cancel = vi.fn(async (_sessionId: string) => {});
  readonly resume = vi.fn(async (sessionId: string): Promise<RuntimeSession> => ({
    id: sessionId,
    runtime: this.kind,
    executionId: 'resumed'
  }));
  readonly close = vi.fn(async (_sessionId: string) => {});

  constructor(
    readonly kind: string,
    readonly sessionPersistence: 'ephemeral' | 'durable'
  ) {}

  onEvent(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function request(overrides: Partial<RuntimeExecutionRequest> = {}): RuntimeExecutionRequest {
  return {
    ownerId: 'owner-a',
    runtimeKind: 'codex-app-server',
    executionId: 'exec-a',
    input: 'Inspect the repository',
    model: null,
    reasoningEffort: null,
    cwd: '/workspace',
    ...overrides
  };
}

describe('runtime-neutral agent broker', () => {
  it('selects the requested runtime and owns its provider session by opaque owner id', async () => {
    const registry = new AgentRuntimeRegistry();
    const browser = new FakeRuntime('chatgpt-browser', 'ephemeral');
    const codex = new FakeRuntime('codex-app-server', 'durable');
    registry.register(browser);
    registry.register(codex);
    const broker = new RuntimeExecutionBroker(registry);

    const binding = await broker.start(request());

    expect(codex.start).toHaveBeenCalledOnce();
    expect(browser.start).not.toHaveBeenCalled();
    expect(binding).toEqual({
      ownerId: 'owner-a',
      runtimeKind: 'codex-app-server',
      sessionId: 'codex-app-server-session',
      executionId: 'exec-a'
    });
    expect(broker.binding('owner-a')).toEqual(binding);
  });

  it('persists only durable provider sessions and resumes them without replaying the original task', async () => {
    const registry = new AgentRuntimeRegistry();
    const browser = new FakeRuntime('chatgpt-browser', 'ephemeral');
    const codex = new FakeRuntime('codex-app-server', 'durable');
    registry.register(browser);
    registry.register(codex);
    const broker = new RuntimeExecutionBroker(registry);

    await broker.start(request());
    await broker.start(request({
      ownerId: 'owner-browser',
      runtimeKind: 'chatgpt-browser',
      executionId: 'exec-browser'
    }));

    const snapshot = broker.snapshot();
    expect(snapshot.bindings).toEqual([{
      ownerId: 'owner-a',
      runtimeKind: 'codex-app-server',
      sessionId: 'codex-app-server-session',
      executionId: 'exec-a'
    }]);

    const restored = new RuntimeExecutionBroker(registry);
    restored.restore(snapshot);
    await restored.start(request({ executionId: 'exec-after-restart' }));

    expect(codex.resume).toHaveBeenCalledWith('codex-app-server-session');
    expect(codex.start).toHaveBeenCalledTimes(1);
    expect(restored.binding('owner-a')?.executionId).toBe('exec-after-restart');
  });

  it('routes follow-up input and cancellation through session ownership rather than orchestration ids', async () => {
    const registry = new AgentRuntimeRegistry();
    const codex = new FakeRuntime('codex-app-server', 'durable');
    registry.register(codex);
    const broker = new RuntimeExecutionBroker(registry);

    await broker.start(request());
    await broker.send('owner-a', { text: 'Check the tests too' });
    await broker.cancel('owner-a');

    expect(codex.send).toHaveBeenCalledWith('codex-app-server-session', { text: 'Check the tests too' });
    expect(codex.cancel).toHaveBeenCalledWith('codex-app-server-session');
  });

  it('keeps runtime ownership durable and runtime selection outside role semantics', () => {
    const agents = readFileSync(new URL('../src/main/agents.ts', import.meta.url), 'utf8');
    const bridge = readFileSync(new URL('../src/main/bridge.ts', import.meta.url), 'utf8');
    const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');

    expect(agents).toContain('runtimeOwnerId');
    expect(agents).toContain('runtimeKind');
    expect(bridge).toContain('runtimeExecutionBroker.start({');
    expect(bridge).not.toContain('browserRuntime.start({');
    expect(index).toContain("const RUNTIME_OWNERSHIP_STATE = 'runtime-ownership'");
    expect(index).toContain('runtimeExecutionBroker.restore(');
    expect(index).toContain('runtimeExecutionBroker.snapshot()');
  });
});
