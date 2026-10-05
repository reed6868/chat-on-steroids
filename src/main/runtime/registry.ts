import type { AgentRuntime } from './agent-runtime.js';

export class AgentRuntimeRegistry {
  private readonly runtimes = new Map<string, AgentRuntime>();

  register(runtime: AgentRuntime): () => void {
    if (this.runtimes.has(runtime.kind)) {
      throw new Error(`Runtime ${runtime.kind} is already registered`);
    }
    this.runtimes.set(runtime.kind, runtime);
    return () => {
      if (this.runtimes.get(runtime.kind) === runtime) this.runtimes.delete(runtime.kind);
    };
  }

  get(kind: string): AgentRuntime | null {
    return this.runtimes.get(kind) ?? null;
  }

  require(kind: string): AgentRuntime {
    const runtime = this.get(kind);
    if (!runtime) throw new Error(`Runtime ${kind} is not registered`);
    return runtime;
  }
}
