import { describe, expect, it, vi } from 'vitest';
import {
  CODEX_APP_SERVER_RUNTIME,
  CodexAppServerRuntime,
  type CodexAppServerClient,
  type CodexAppServerNotification
} from '../src/main/runtime/codex-app-server-runtime.js';
import { codexChatgptPlanLaunch } from '../src/main/runtime/codex-app-server-client.js';

class FakeCodexClient implements CodexAppServerClient {
  ready = vi.fn(async () => {});
  startThread = vi.fn(async () => 'thread-123');
  resumeThread = vi.fn(async () => {});
  startTurn = vi.fn(async () => 'turn-1');
  interruptTurn = vi.fn(async () => {});
  listeners = new Set<(notification: CodexAppServerNotification) => void>();

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(notification: CodexAppServerNotification): void {
    for (const listener of this.listeners) listener(notification);
  }
}

describe('Codex app-server runtime', () => {
  it('uses the provider thread id as runtime session identity', async () => {
    const client = new FakeCodexClient();
    const runtime = new CodexAppServerRuntime(client);

    const session = await runtime.start({
      executionId: 'exec-7',
      input: 'Inspect the repository',
      model: 'gpt-test',
      reasoningEffort: 'high',
      cwd: '/workspace'
    });

    expect(runtime.kind).toBe(CODEX_APP_SERVER_RUNTIME);
    expect(client.ready).toHaveBeenCalledOnce();
    expect(client.startThread).toHaveBeenCalledWith({
      model: 'gpt-test',
      cwd: '/workspace'
    });
    expect(client.startTurn).toHaveBeenCalledWith({
      threadId: 'thread-123',
      text: 'Inspect the repository',
      model: 'gpt-test',
      effort: 'high',
      cwd: '/workspace'
    });
    expect(session).toEqual({
      id: 'thread-123',
      runtime: CODEX_APP_SERVER_RUNTIME,
      executionId: 'exec-7'
    });
  });

  it('maps app-server output and terminal status into runtime events', async () => {
    const client = new FakeCodexClient();
    const runtime = new CodexAppServerRuntime(client);
    const events: unknown[] = [];
    runtime.onEvent(event => events.push(event));

    await runtime.start({
      executionId: 'exec-8',
      input: 'Review',
      model: null,
      reasoningEffort: null,
      cwd: null
    });

    client.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-123', delta: 'hello' } });
    client.emit({ method: 'turn/completed', params: { threadId: 'thread-123', turn: { id: 'turn-1', status: 'completed' } } });

    expect(events).toContainEqual({ type: 'output-delta', sessionId: 'thread-123', text: 'hello' });
    expect(events).toContainEqual({ type: 'turn-completed', sessionId: 'thread-123' });
  });

  it('interrupts the active provider turn without using orchestration ids', async () => {
    const client = new FakeCodexClient();
    const runtime = new CodexAppServerRuntime(client);

    await runtime.start({
      executionId: 'exec-9',
      input: 'Review',
      model: null,
      reasoningEffort: null,
      cwd: null
    });
    client.emit({ method: 'turn/started', params: { threadId: 'thread-123', turn: { id: 'turn-77' } } });

    await runtime.cancel('thread-123');

    expect(client.interruptTurn).toHaveBeenCalledWith('thread-123', 'turn-77');
  });

  it('keeps the ChatGPT Plan access token out of process arguments', () => {
    const launch = codexChatgptPlanLaunch('secret-token', { BASE: '1' });

    expect(launch.command).toBe('codex');
    expect(launch.args.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(launch.args.join(' ')).toContain('model_provider="openai_chatgpt_plan"');
    expect(launch.args.join(' ')).toContain('wire_api="responses"');
    expect(launch.args.join(' ')).not.toContain('secret-token');
    expect(launch.env).toEqual(expect.objectContaining({ BASE: '1', ACCESS_TOKEN: 'secret-token' }));
  });
});
