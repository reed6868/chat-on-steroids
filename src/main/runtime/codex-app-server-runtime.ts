import { randomUUID } from 'node:crypto';
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeInput,
  RuntimeSession,
  RuntimeStartOptions
} from './agent-runtime.js';

export const CODEX_APP_SERVER_RUNTIME = 'codex-app-server';

export type CodexAppServerNotification =
  | { method: 'turn/started'; params: { threadId: string; turn: { id: string } } }
  | { method: 'item/agentMessage/delta'; params: { threadId: string; delta: string } }
  | { method: 'turn/completed'; params: { threadId: string; turn: { id: string; status: string } } }
  | {
      method: 'error';
      params: {
        threadId?: string;
        turnId?: string;
        message?: string;
        error?: { message?: string };
        willRetry?: boolean;
      };
    };

export interface CodexThreadOptions {
  model: string | null;
  cwd: string | null;
}

export interface CodexTurnOptions extends CodexThreadOptions {
  threadId: string;
  text: string;
  effort: string | null;
}

export interface CodexAppServerClient {
  ready(): Promise<void>;
  startThread(options: CodexThreadOptions): Promise<string>;
  resumeThread(threadId: string): Promise<void>;
  startTurn(options: CodexTurnOptions): Promise<string>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void;
}

interface SessionState {
  session: RuntimeSession;
  model: string | null;
  effort: string | null;
  cwd: string | null;
}

function codexEffort(effort: RuntimeStartOptions['reasoningEffort']): string | null {
  // "pro" is a ChatGPT browser tier in COS, not an API reasoning effort.
  return effort === 'pro' ? null : effort;
}

export class CodexAppServerRuntime implements AgentRuntime {
  readonly kind = CODEX_APP_SERVER_RUNTIME;
  readonly sessionPersistence = 'durable' as const;
  private readonly listeners = new Set<RuntimeEventListener>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly activeTurns = new Map<string, string>();

  constructor(private readonly client: CodexAppServerClient) {
    client.onNotification(notification => this.handleNotification(notification));
  }

  async start(options: RuntimeStartOptions): Promise<RuntimeSession | null> {
    await this.client.ready();
    const model = options.model;
    const cwd = options.cwd ?? null;
    const effort = codexEffort(options.reasoningEffort);
    const threadId = await this.client.startThread({ model, cwd });
    const session: RuntimeSession = {
      id: threadId,
      runtime: this.kind,
      executionId: options.executionId
    };
    this.sessions.set(threadId, { session, model, effort, cwd });
    this.emit({ type: 'session-started', session });

    const turnId = await this.client.startTurn({
      threadId,
      text: options.input,
      model,
      effort,
      cwd
    });
    this.activeTurns.set(threadId, turnId);
    return session;
  }

  async send(sessionId: string, input: RuntimeInput): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Unknown Codex runtime session ${sessionId}`);
    const turnId = await this.client.startTurn({
      threadId: sessionId,
      text: input.text,
      model: state.model,
      effort: state.effort,
      cwd: state.cwd
    });
    this.activeTurns.set(sessionId, turnId);
  }

  async cancel(sessionId: string): Promise<void> {
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) return;
    await this.client.interruptTurn(sessionId, turnId);
  }

  async resume(sessionId: string): Promise<RuntimeSession> {
    await this.client.ready();
    await this.client.resumeThread(sessionId);
    const existing = this.sessions.get(sessionId);
    if (existing) return existing.session;

    const session: RuntimeSession = {
      id: sessionId,
      runtime: this.kind,
      executionId: randomUUID()
    };
    this.sessions.set(sessionId, { session, model: null, effort: null, cwd: null });
    this.emit({ type: 'session-started', session });
    return session;
  }

  async close(sessionId: string): Promise<void> {
    this.activeTurns.delete(sessionId);
    if (!this.sessions.delete(sessionId)) return;
    this.emit({ type: 'session-closed', sessionId });
  }

  onEvent(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private handleNotification(notification: CodexAppServerNotification): void {
    const { method, params } = notification;
    if (method === 'turn/started') {
      this.activeTurns.set(params.threadId, params.turn.id);
      this.emit({ type: 'turn-started', sessionId: params.threadId });
      return;
    }
    if (method === 'item/agentMessage/delta') {
      this.emit({ type: 'output-delta', sessionId: params.threadId, text: params.delta });
      return;
    }
    if (method === 'turn/completed') {
      this.activeTurns.delete(params.threadId);
      if (params.turn.status === 'completed') {
        this.emit({ type: 'turn-completed', sessionId: params.threadId });
      } else {
        this.emit({
          type: 'turn-failed',
          sessionId: params.threadId,
          message: `Codex turn ended with status ${params.turn.status}`
        });
      }
      return;
    }
    if (method === 'error' && params.threadId && params.willRetry !== true) {
      this.emit({
        type: 'turn-failed',
        sessionId: params.threadId,
        message: params.error?.message ?? params.message ?? 'Codex app-server reported an error'
      });
    }
  }
}
