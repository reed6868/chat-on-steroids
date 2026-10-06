import type {
  AgentRuntime,
  RuntimeEventListener,
  RuntimeInput,
  RuntimeSession,
  RuntimeStartOptions
} from './agent-runtime.js';
import {
  CODEX_APP_SERVER_RUNTIME,
  CodexAppServerRuntime
} from './codex-app-server-runtime.js';
import {
  StdioCodexAppServerClient,
  type StdioCodexAppServerClientOptions
} from './codex-app-server-client.js';
import type { ChatgptPlanAuth } from '../chatgpt-plan-auth.js';

interface DisposableCodexClient {
  dispose(): void;
}

type ClientFactory = (options: StdioCodexAppServerClientOptions) => StdioCodexAppServerClient & DisposableCodexClient;

/**
 * Authentication-aware Codex runtime.
 *
 * The ChatGPT Plan access token never becomes part of a runtime binding. It is resolved only
 * when an app-server process is needed. If OAuth refresh rotates the token between turns, the
 * old app-server is retired and the durable Codex thread is resumed through a fresh process.
 */
export class ChatgptPlanCodexRuntime implements AgentRuntime {
  readonly kind = CODEX_APP_SERVER_RUNTIME;
  readonly sessionPersistence = 'durable' as const;

  private readonly listeners = new Set<RuntimeEventListener>();
  private client: (StdioCodexAppServerClient & DisposableCodexClient) | null = null;
  private runtime: CodexAppServerRuntime | null = null;
  private token: string | null = null;
  private dropEvents: (() => void) | null = null;

  constructor(
    private readonly auth: Pick<ChatgptPlanAuth, 'accessToken'>,
    private readonly version: string,
    private readonly clientFactory: ClientFactory = options => new StdioCodexAppServerClient(options)
  ) {}

  async start(options: RuntimeStartOptions): Promise<RuntimeSession | null> {
    const { runtime } = await this.ensureRuntime();
    return runtime.start(options);
  }

  async send(sessionId: string, input: RuntimeInput): Promise<void> {
    const { runtime, replaced } = await this.ensureRuntime();
    if (replaced) await runtime.resume(sessionId);
    await runtime.send(sessionId, input);
  }

  async cancel(sessionId: string): Promise<void> {
    const { runtime, replaced } = await this.ensureRuntime();
    // A refreshed process cannot interrupt a turn owned by the retired process. Resuming first
    // restores durable thread ownership and makes a subsequent turn/cancel sequence coherent.
    if (replaced) await runtime.resume(sessionId);
    await runtime.cancel(sessionId);
  }

  async resume(sessionId: string): Promise<RuntimeSession> {
    const { runtime } = await this.ensureRuntime();
    return runtime.resume(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const { runtime } = await this.ensureRuntime();
    await runtime.close(sessionId);
  }

  onEvent(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.dropEvents?.();
    this.dropEvents = null;
    this.client?.dispose();
    this.client = null;
    this.runtime = null;
    this.token = null;
  }

  private async ensureRuntime(): Promise<{ runtime: CodexAppServerRuntime; replaced: boolean }> {
    const accessToken = await this.auth.accessToken();
    if (this.runtime && this.token === accessToken) return { runtime: this.runtime, replaced: false };

    this.dropEvents?.();
    this.dropEvents = null;
    this.client?.dispose();

    const client = this.clientFactory({ accessToken, version: this.version });
    const runtime = new CodexAppServerRuntime(client);
    this.dropEvents = runtime.onEvent(event => {
      for (const listener of this.listeners) listener(event);
    });
    this.client = client;
    this.runtime = runtime;
    const replaced = this.token !== null;
    this.token = accessToken;
    return { runtime, replaced };
  }
}
