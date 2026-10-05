import {
  UnsupportedRuntimeOperationError,
  type AgentRuntime,
  type RuntimeEventListener,
  type RuntimeInput,
  type RuntimeSession,
  type RuntimeStartOptions
} from './agent-runtime.js';

export const CHATGPT_BROWSER_RUNTIME = 'chatgpt-browser';

export type BrowserRuntimeStart = (request: RuntimeStartOptions) => void;

export class BrowserAgentRuntime implements AgentRuntime {
  readonly kind = CHATGPT_BROWSER_RUNTIME;
  private readonly listeners = new Set<RuntimeEventListener>();

  constructor(private readonly startTransport: BrowserRuntimeStart) {}

  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.startTransport(options);
    const session: RuntimeSession = {
      id: `${this.kind}:${options.executionId}:${options.agentId}`,
      runtime: this.kind,
      executionId: options.executionId,
      agentId: options.agentId
    };
    for (const listener of this.listeners) listener({ type: 'session-started', session });
    return session;
  }

  async send(_sessionId: string, _input: RuntimeInput): Promise<void> {
    throw new UnsupportedRuntimeOperationError(this.kind, 'send');
  }

  async cancel(_sessionId: string): Promise<void> {
    throw new UnsupportedRuntimeOperationError(this.kind, 'cancel');
  }

  async resume(_sessionId: string): Promise<RuntimeSession> {
    throw new UnsupportedRuntimeOperationError(this.kind, 'resume');
  }

  async close(_sessionId: string): Promise<void> {
    throw new UnsupportedRuntimeOperationError(this.kind, 'close');
  }

  onEvent(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
