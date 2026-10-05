import type { ReasoningEffort } from '../../shared/session.js';

export interface RuntimeStartOptions {
  executionId: string;
  input: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  /** Provider working directory when the runtime owns local execution. */
  cwd?: string | null;
}

export interface RuntimeSession {
  id: string;
  runtime: string;
  executionId: string;
}

export interface RuntimeInput {
  text: string;
}

export type RuntimeEvent =
  | { type: 'session-started'; session: RuntimeSession }
  | { type: 'turn-started'; sessionId: string }
  | { type: 'output-delta'; sessionId: string; text: string }
  | { type: 'tool-started'; sessionId: string; tool: string }
  | { type: 'tool-completed'; sessionId: string; tool: string }
  | { type: 'turn-completed'; sessionId: string }
  | { type: 'turn-failed'; sessionId: string; message: string }
  | { type: 'session-closed'; sessionId: string };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface AgentRuntime {
  readonly kind: string;
  start(options: RuntimeStartOptions): Promise<RuntimeSession | null>;
  send(sessionId: string, input: RuntimeInput): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<RuntimeSession>;
  close(sessionId: string): Promise<void>;
  onEvent(listener: RuntimeEventListener): () => void;
}

export class UnsupportedRuntimeOperationError extends Error {
  constructor(runtime: string, operation: string) {
    super(`${runtime} runtime does not support ${operation} through this adapter yet`);
  }
}
