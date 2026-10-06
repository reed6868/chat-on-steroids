import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntime,
  RuntimeEventListener,
  RuntimeInput,
  RuntimeSession,
  RuntimeStartOptions
} from '../src/main/runtime/agent-runtime.js';
import { verifyCodexRuntimeE2E } from '../src/main/runtime/codex-e2e.js';

class GateRuntime implements AgentRuntime {
  readonly kind = 'codex-app-server';
  readonly sessionPersistence = 'durable' as const;
  private readonly listeners = new Set<RuntimeEventListener>();
  close = vi.fn(async () => {});

  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    const session = { id: 'gate-thread', runtime: this.kind, executionId: options.executionId };
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        listener({ type: 'output-delta', sessionId: session.id, text: 'COS_CODEX_E2E_OK' });
        listener({ type: 'turn-completed', sessionId: session.id });
      }
    });
    return session;
  }
  async send(_sessionId: string, _input: RuntimeInput): Promise<void> {}
  async cancel(_sessionId: string): Promise<void> {}
  async resume(sessionId: string): Promise<RuntimeSession> {
    return { id: sessionId, runtime: this.kind, executionId: 'resume' };
  }
  onEvent(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

describe('real Codex E2E gate contract', () => {
  it('requires a completed turn, captures bounded output, and closes the temporary provider thread', async () => {
    const runtime = new GateRuntime();

    const result = await verifyCodexRuntimeE2E(runtime, { timeoutMs: 1000 });

    expect(result).toEqual({
      ok: true,
      output: 'COS_CODEX_E2E_OK'
    });
    expect(runtime.close).toHaveBeenCalledWith('gate-thread');
  });

  it('fails closed when the provider reports a failed turn', async () => {
    const runtime = new GateRuntime();
    runtime.start = vi.fn(async (options: RuntimeStartOptions) => {
      const session = { id: 'failed-thread', runtime: runtime.kind, executionId: options.executionId };
      queueMicrotask(() => {
        for (const listener of (runtime as unknown as { listeners: Set<RuntimeEventListener> }).listeners) {
          listener({ type: 'turn-failed', sessionId: session.id, message: 'provider failed' });
        }
      });
      return session;
    });

    await expect(verifyCodexRuntimeE2E(runtime, { timeoutMs: 1000 })).rejects.toThrow('provider failed');
    expect(runtime.close).toHaveBeenCalledWith('failed-thread');
  });
});
