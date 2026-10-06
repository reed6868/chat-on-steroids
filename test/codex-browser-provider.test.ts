import { beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => ({ infer: vi.fn() }));

vi.mock('../src/main/browser-inference.js', () => ({
  inferWithChatGPTBrowser: browser.infer
}));

const provider = await import('../src/main/codex-browser-provider.js');

const baseRequest = (over: Record<string, unknown> = {}) => ({
  model: 'gpt-5.6-sol',
  stream: true,
  input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Work as a coding agent.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the repository.' }] }
  ],
  tools: [
    {
      type: 'function',
      name: 'exec_command',
      description: 'Run a command',
      parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false }
    }
  ],
  tool_choice: 'auto',
  parallel_tool_calls: false,
  reasoning: { effort: 'high' },
  store: false,
  include: [],
  ...over
});

function events(body: string): any[] {
  return body
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)));
}

beforeEach(() => {
  browser.infer.mockReset();
});

describe('Codex Responses -> ChatGPT Web provider', () => {
  it('uses one temporary browser inference and returns a valid assistant-message SSE response', async () => {
    browser.infer.mockResolvedValueOnce(JSON.stringify({ type: 'message', text: 'Repository inspected.' }));

    const reply = await provider.handleCodexBrowserResponse(baseRequest(), new AbortController().signal);

    expect(browser.infer).toHaveBeenCalledTimes(1);
    expect(browser.infer).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      signal: expect.any(AbortSignal)
    }));
    const prompt = browser.infer.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain('Do not call ChatGPT tools, apps, connectors, or browse on your own');
    expect(prompt).toContain('"role":"developer"');
    expect(prompt).toContain('"name":"exec_command"');

    expect(reply).toMatchObject({ status: 200, contentType: 'text/event-stream; charset=utf-8' });
    const streamed = events(reply.body);
    expect(streamed.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_item.done',
      'response.completed'
    ]);
    expect(streamed[1]).toMatchObject({
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Repository inspected.' }]
      }
    });
    expect(streamed[2]?.response?.id).toBe(streamed[0]?.response?.id);
  });

  it('turns only advertised tool calls into Codex function_call items', async () => {
    browser.infer.mockResolvedValueOnce(JSON.stringify({
      type: 'tool_calls',
      calls: [{ name: 'exec_command', arguments: { cmd: 'pwd' } }]
    }));

    const reply = await provider.handleCodexBrowserResponse(baseRequest(), new AbortController().signal);
    const streamed = events(reply.body);
    expect(streamed[1]).toMatchObject({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'pwd' })
      }
    });
    expect(streamed[1]?.item?.call_id).toMatch(/^call_[0-9a-f-]{36}$/);
  });

  it('supports Codex client-side tool_search without exposing deferred tools as direct calls', async () => {
    const searchTool = {
      type: 'tool_search',
      execution: 'client',
      description: 'Search deferred tool metadata.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['query'],
        additionalProperties: false
      }
    };
    browser.infer.mockResolvedValueOnce(JSON.stringify({
      type: 'tool_calls',
      calls: [{ name: 'tool_search', arguments: { query: 'calendar', limit: 1 } }]
    }));

    const reply = await provider.handleCodexBrowserResponse(
      baseRequest({ tools: [searchTool] }),
      new AbortController().signal
    );
    const streamed = events(reply.body);
    expect(streamed[1]).toMatchObject({
      type: 'response.output_item.done',
      item: {
        type: 'tool_search_call',
        execution: 'client',
        arguments: { query: 'calendar', limit: 1 }
      }
    });
    expect(streamed[1]?.item?.call_id).toMatch(/^call_[0-9a-f-]{36}$/);

    browser.infer.mockResolvedValueOnce(JSON.stringify({
      type: 'tool_calls',
      calls: [{ namespace: 'calendar', name: 'create_event', arguments: { title: 'x' } }]
    }));
    await expect(provider.handleCodexBrowserResponse(baseRequest({
      tools: [
        searchTool,
        {
          type: 'namespace',
          name: 'calendar',
          description: 'Calendar tools',
          tools: [{
            type: 'function',
            name: 'create_event',
            defer_loading: true,
            parameters: { type: 'object', properties: { title: { type: 'string' } } }
          }]
        }
      ]
    }), new AbortController().signal)).rejects.toMatchObject({
      status: 502,
      code: 'invalid_model_output'
    });
  });

  it('fails closed on malformed output, unknown tools, tool-choice violations, and forbidden parallel calls', async () => {
    const cases: Array<[string, unknown, Record<string, unknown>]> = [
      ['not JSON', 'plain prose', {}],
      ['unknown tool', JSON.stringify({ type: 'tool_calls', calls: [{ name: 'delete_everything', arguments: {} }] }), {}],
      ['tool choice none', JSON.stringify({ type: 'tool_calls', calls: [{ name: 'exec_command', arguments: { cmd: 'pwd' } }] }), { tool_choice: 'none' }],
      ['required but message', JSON.stringify({ type: 'message', text: 'done' }), { tool_choice: 'required' }],
      ['parallel disabled', JSON.stringify({ type: 'tool_calls', calls: [
        { name: 'exec_command', arguments: { cmd: 'pwd' } },
        { name: 'exec_command', arguments: { cmd: 'ls' } }
      ] }), { parallel_tool_calls: false }]
    ];

    for (const [name, output, over] of cases) {
      browser.infer.mockResolvedValueOnce(output as string);
      await expect(provider.handleCodexBrowserResponse(baseRequest(over), new AbortController().signal), name)
        .rejects.toMatchObject({ status: 502, code: 'invalid_model_output' });
    }
  });

  it('rejects unsupported request transport and browser-overflowing context before starting inference', async () => {
    await expect(provider.handleCodexBrowserResponse(baseRequest({ stream: false }), new AbortController().signal))
      .rejects.toMatchObject({ status: 400, code: 'unsupported_request' });

    await expect(provider.handleCodexBrowserResponse(baseRequest({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(100_000) }] }]
    }), new AbortController().signal)).rejects.toMatchObject({ status: 413, code: 'context_length_exceeded' });
    expect(browser.infer).not.toHaveBeenCalled();
  });
});
