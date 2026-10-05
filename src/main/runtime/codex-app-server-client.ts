import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  CodexAppServerClient,
  CodexAppServerNotification,
  CodexThreadOptions,
  CodexTurnOptions
} from './codex-app-server-runtime.js';

export interface CodexLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function codexChatgptPlanLaunch(
  accessToken: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): CodexLaunch {
  return {
    command: 'codex',
    args: [
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'model_provider="openai_chatgpt_plan"',
      '-c',
      'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
      '-c',
      'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
      '-c',
      'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
      '-c',
      'model_providers.openai_chatgpt_plan.wire_api="responses"',
      '-c',
      'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
      '-c',
      'model_providers.openai_chatgpt_plan.supports_websockets=false'
    ],
    env: { ...baseEnv, ACCESS_TOKEN: accessToken }
  };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: unknown;
}

export interface StdioCodexAppServerClientOptions {
  accessToken: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Codex app-server returned no ${context}`);
  }
  return value;
}

export class StdioCodexAppServerClient implements CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private stdoutBuffer = '';
  private readyPromise: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(notification: CodexAppServerNotification) => void>();

  constructor(private readonly options: StdioCodexAppServerClientOptions) {}

  ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.initialize().catch(error => {
        this.readyPromise = null;
        throw error;
      });
    }
    return this.readyPromise;
  }

  async startThread(options: CodexThreadOptions): Promise<string> {
    await this.ready();
    const params: Record<string, unknown> = {};
    if (options.model) params.model = options.model;
    if (options.cwd) params.cwd = options.cwd;
    const result = record(await this.request('thread/start', params));
    const thread = record(result?.thread);
    return requiredString(thread?.id, 'thread id');
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.ready();
    await this.request('thread/resume', { threadId });
  }

  async startTurn(options: CodexTurnOptions): Promise<string> {
    await this.ready();
    const params: Record<string, unknown> = {
      threadId: options.threadId,
      input: [{ type: 'text', text: options.text }]
    };
    if (options.model) params.model = options.model;
    if (options.effort) params.effort = options.effort;
    if (options.cwd) params.cwd = options.cwd;
    const result = record(await this.request('turn/start', params));
    const turn = record(result?.turn);
    return requiredString(turn?.id, 'turn id');
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.ready();
    await this.request('turn/interrupt', { threadId, turnId });
  }

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.readyPromise = null;
    this.rejectPending(new Error('Codex app-server client closed'));
    if (child && !child.killed) child.kill();
  }

  private async initialize(): Promise<void> {
    const launch = codexChatgptPlanLaunch(this.options.accessToken, this.options.env);
    const child = spawn(this.options.command ?? launch.command, launch.args, {
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    // Drain stderr so a verbose server cannot block on its pipe. Authentication material is
    // never logged or copied from stderr by this adapter.
    child.stderr.resume();
    child.once('error', error => this.handleExit(error));
    child.once('exit', (code, signal) => {
      this.handleExit(new Error(
        `Codex app-server exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}`
      ));
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'chat_on_steroids',
        title: 'Chat On Steroids',
        version: this.options.version
      }
    });
    this.notify('initialized');
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error('Codex app-server is not running');
    const message = params === undefined ? { method } : { method, params };
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: RpcResponse;
      try {
        message = JSON.parse(line) as RpcResponse;
      } catch {
        continue;
      }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(
            `Codex app-server request failed${message.error.code === undefined ? '' : ` (${message.error.code})`}: ${message.error.message ?? 'unknown error'}`
          ));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }
      if (typeof message.method === 'string') {
        const notification = { method: message.method, params: message.params } as CodexAppServerNotification;
        for (const listener of this.listeners) listener(notification);
      }
    }
  }

  private handleExit(error: Error): void {
    if (!this.child && !this.readyPromise) return;
    this.child = null;
    this.readyPromise = null;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
