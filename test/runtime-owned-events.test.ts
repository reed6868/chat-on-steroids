import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntime,
  RuntimeEventListener,
  RuntimeInput,
  RuntimeSession,
  RuntimeStartOptions
} from '../src/main/runtime/agent-runtime.js';
import { AgentRuntimeRegistry } from '../src/main/runtime/registry.js';
import { RuntimeExecutionBroker } from '../src/main/runtime/agent-broker.js';

class EventRuntime implements AgentRuntime {
  readonly kind = 'event-runtime';
  readonly sessionPersistence = 'durable' as const;
  private listeners = new Set<RuntimeEventListener>();

  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    const session = { id: 'provider-session-1', runtime: this.kind, executionId: options.executionId };
    for (const listener of this.listeners) listener({ type: 'session-started', session });
    return session;
  }
  async send(_sessionId: string, _input: RuntimeInput): Promise<void> {}
  async cancel(_sessionId: string): Promise<void> {}
  async resume(sessionId: string): Promise<RuntimeSession> {
    return { id: sessionId, runtime: this.kind, executionId: 'resume-exec' };
  }
  async close(_sessionId: string): Promise<void> {}
  onEvent(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: Parameters<RuntimeEventListener>[0]): void {
    for (const listener of this.listeners) listener(event);
  }
}

describe('runtime-owned lifecycle events', () => {
  it('maps provider events back to the opaque runtime owner without orchestration ids in the runtime', async () => {
    const registry = new AgentRuntimeRegistry();
    const runtime = new EventRuntime();
    registry.register(runtime);
    const broker = new RuntimeExecutionBroker(registry);
    const seen = vi.fn();
    broker.onEvent(seen);

    await broker.start({
      ownerId: 'owner-opaque-1',
      runtimeKind: runtime.kind,
      executionId: 'execution-1',
      input: 'work',
      model: null,
      reasoningEffort: null
    });

    runtime.emit({ type: 'turn-started', sessionId: 'provider-session-1' });
    runtime.emit({ type: 'output-delta', sessionId: 'provider-session-1', text: 'answer' });
    runtime.emit({ type: 'turn-completed', sessionId: 'provider-session-1' });

    expect(seen).toHaveBeenCalledWith('owner-opaque-1', { type: 'session-started', session: expect.objectContaining({ id: 'provider-session-1' }) });
    expect(seen).toHaveBeenCalledWith('owner-opaque-1', { type: 'turn-started', sessionId: 'provider-session-1' });
    expect(seen).toHaveBeenCalledWith('owner-opaque-1', { type: 'output-delta', sessionId: 'provider-session-1', text: 'answer' });
    expect(seen).toHaveBeenCalledWith('owner-opaque-1', { type: 'turn-completed', sessionId: 'provider-session-1' });
  });
});
