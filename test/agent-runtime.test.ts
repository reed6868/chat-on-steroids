import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeRegistry } from '../src/main/runtime/registry.js';
import { BrowserAgentRuntime } from '../src/main/runtime/browser-runtime.js';
import type { RuntimeStartOptions } from '../src/main/runtime/agent-runtime.js';

describe('agent runtime boundary', () => {
  it('registers execution providers by runtime kind without encoding agent roles', () => {
    const start = vi.fn();
    const runtime = new BrowserAgentRuntime(start);
    const registry = new AgentRuntimeRegistry();

    registry.register(runtime);

    expect(registry.require('chatgpt-browser')).toBe(runtime);
    expect(() => registry.register(runtime)).toThrow(/already registered/i);
  });

  it('keeps orchestration correlation separate from provider execution identity', async () => {
    const seen: RuntimeStartOptions[] = [];
    const runtime = new BrowserAgentRuntime((request) => {
      seen.push(request);
      return 'browser-command-42';
    });

    const session = await runtime.start({
      executionId: 'runtime-correlation-9',
      input: 'Inspect the repository',
      model: 'gpt-test',
      reasoningEffort: 'high'
    });

    expect(seen).toEqual([{
      executionId: 'runtime-correlation-9',
      input: 'Inspect the repository',
      model: 'gpt-test',
      reasoningEffort: 'high'
    }]);
    expect(session).toEqual({
      id: 'browser-command-42',
      runtime: 'chatgpt-browser',
      executionId: 'runtime-correlation-9'
    });
  });

  it('does not publish a runtime session when the browser transport refuses the launch', async () => {
    const listener = vi.fn();
    const runtime = new BrowserAgentRuntime(() => null);
    runtime.onEvent(listener);

    await expect(runtime.start({
      executionId: 'runtime-correlation-10',
      input: 'Inspect the repository',
      model: null,
      reasoningEffort: null
    })).resolves.toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps orchestration roles and ChatGPT conversation identity out of the runtime contract', () => {
    const source = readFileSync(new URL('../src/main/runtime/agent-runtime.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/\b(?:worker|coordinator|prime)\b/i);
    expect(source).not.toContain('conversationId');
    expect(source).not.toContain('agentId');
    expect(source).not.toContain('runId');
  });

  it('routes the existing browser spawn boundary through the browser runtime adapter', () => {
    const bridge = readFileSync(new URL('../src/main/bridge.ts', import.meta.url), 'utf8');

    expect(bridge).toContain("from './runtime/browser-runtime.js'");
    expect(bridge).toContain("from './runtime/registry.js'");
    expect(bridge).toContain('agentRuntimes.require(CHATGPT_BROWSER_RUNTIME)');
    expect(bridge).toContain('const executionId = randomUUID()');
    expect(bridge).toContain('browserRuntimeBindings.set(executionId');
    expect(bridge).toContain('return command?.id ?? null');
  });
});
