import type { RuntimeInput, RuntimeSession, RuntimeStartOptions } from './agent-runtime.js';
import type { AgentRuntimeRegistry } from './registry.js';

export interface RuntimeExecutionRequest extends RuntimeStartOptions {
  ownerId: string;
  runtimeKind: string;
}

export interface RuntimeBinding {
  ownerId: string;
  runtimeKind: string;
  sessionId: string;
  executionId: string;
}

export interface RuntimeOwnershipSnapshot {
  version: 1;
  bindings: RuntimeBinding[];
}

export class RuntimeExecutionBroker {
  private readonly bindings = new Map<string, RuntimeBinding>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly registry: AgentRuntimeRegistry) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  binding(ownerId: string): RuntimeBinding | null {
    const binding = this.bindings.get(ownerId);
    return binding ? { ...binding } : null;
  }

  async start(request: RuntimeExecutionRequest): Promise<RuntimeBinding | null> {
    const runtime = this.registry.require(request.runtimeKind);
    const existing = this.bindings.get(request.ownerId);
    let session: RuntimeSession | null;

    if (existing) {
      if (existing.runtimeKind !== request.runtimeKind) {
        throw new Error(
          `Runtime owner ${request.ownerId} is already bound to ${existing.runtimeKind}`
        );
      }
      if (runtime.sessionPersistence === 'durable') {
        session = await runtime.resume(existing.sessionId);
      } else {
        session = await runtime.start(request);
      }
    } else {
      session = await runtime.start(request);
    }

    if (!session) return null;
    const binding: RuntimeBinding = {
      ownerId: request.ownerId,
      runtimeKind: runtime.kind,
      sessionId: session.id,
      executionId: request.executionId
    };
    this.bindings.set(request.ownerId, binding);
    this.changed();
    return { ...binding };
  }

  async send(ownerId: string, input: RuntimeInput): Promise<void> {
    const binding = this.requireBinding(ownerId);
    await this.registry.require(binding.runtimeKind).send(binding.sessionId, input);
  }

  async cancel(ownerId: string): Promise<void> {
    const binding = this.requireBinding(ownerId);
    await this.registry.require(binding.runtimeKind).cancel(binding.sessionId);
  }

  async close(ownerId: string): Promise<void> {
    const binding = this.bindings.get(ownerId);
    if (!binding) return;
    await this.registry.require(binding.runtimeKind).close(binding.sessionId);
    this.bindings.delete(ownerId);
    this.changed();
  }

  snapshot(): RuntimeOwnershipSnapshot {
    const bindings = [...this.bindings.values()]
      .filter(binding => {
        const runtime = this.registry.get(binding.runtimeKind);
        return binding.runtimeKind !== 'chatgpt-browser' &&
          (!runtime || runtime.sessionPersistence === 'durable');
      })
      .map(binding => ({ ...binding }));
    return { version: 1, bindings };
  }

  restore(snapshot: RuntimeOwnershipSnapshot | null | undefined): void {
    this.bindings.clear();
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.bindings)) return;
    for (const binding of snapshot.bindings) {
      if (
        !binding ||
        typeof binding.ownerId !== 'string' ||
        typeof binding.runtimeKind !== 'string' ||
        typeof binding.sessionId !== 'string' ||
        typeof binding.executionId !== 'string'
      ) continue;
      // Browser command ids are process-local. Other provider-owned ids may be restored before
      // that provider is registered during startup; start() will require the provider later.
      if (binding.runtimeKind === 'chatgpt-browser') continue;
      this.bindings.set(binding.ownerId, { ...binding });
    }
  }

  private requireBinding(ownerId: string): RuntimeBinding {
    const binding = this.bindings.get(ownerId);
    if (!binding) throw new Error(`No runtime session is bound to owner ${ownerId}`);
    return binding;
  }
}
