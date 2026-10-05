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

  it('passes only runtime-neutral execution identity into the browser provider', async () => {
    const seen: RuntimeStartOptions[] = [];
    const runtime = new BrowserAgentRuntime((request) => {
      seen.push(request);
    });

    const session = await runtime.start({
      executionId: 'run-123',
      agentId: 'agent-7',
      input: 'Inspect the repository',
      model: 'gpt-test',
      reasoningEffort: 'high'
    });

    expect(seen).toEqual([{
      executionId: 'run-123',
      agentId: 'agent-7',
      input: 'Inspect the repository',
      model: 'gpt-test',
      reasoningEffort: 'high'
    }]);
    expect(session).toEqual({
      id: 'chatgpt-browser:run-123:agent-7',
      runtime: 'chatgpt-browser',
      executionId: 'run-123',
      agentId: 'agent-7'
    });
  });

  it('keeps orchestration roles and ChatGPT conversation identity out of the runtime contract', () => {
    const source = readFileSync(new URL('../src/main/runtime/agent-runtime.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/\b(?:worker|coordinator|prime)\b/i);
    expect(source).not.toContain('conversationId');
  });

  it('routes the existing browser spawn boundary through the browser runtime adapter', () => {
    const bridge = readFileSync(new URL('../src/main/bridge.ts', import.meta.url), 'utf8');

    expect(bridge).toContain("from './runtime/browser-runtime.js'");
    expect(bridge).toContain("from './runtime/registry.js'");
    expect(bridge).toContain('agentRuntimes.require(CHATGPT_BROWSER_RUNTIME)');
  });
});
