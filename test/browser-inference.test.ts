import { beforeEach, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => ({ request: vi.fn() }));
const policy = vi.hoisted(() => ({ strict: true }));
vi.mock('../src/main/session/input.js', () => ({ requestBrowserDecision: browser.request }));
vi.mock('../src/main/session/conversation-access.js', () => ({ strictChatAllowlistEnabled: () => policy.strict }));

const { runBrowserInference } = await import('../src/main/browser-inference.js');

beforeEach(() => {
  policy.strict = true;
  browser.request.mockReset();
});

it('uses the existing temporary browser decision transport without creating runtime ownership', async () => {
  browser.request.mockResolvedValueOnce('browser answer');
  const controller = new AbortController();

  await expect(runBrowserInference({
    prompt: 'Solve this',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high'
  }, controller.signal)).resolves.toEqual({ text: 'browser answer' });

  expect(browser.request).toHaveBeenCalledWith('Solve this', controller.signal, {
    conversationId: null,
    lifetime: 'temporary-planner',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high'
  });
});

it('defaults to the current ChatGPT selection instead of inventing a provider identity', async () => {
  browser.request.mockResolvedValueOnce('ok');
  const controller = new AbortController();

  await runBrowserInference({ prompt: 'Use the browser model' }, controller.signal);

  expect(browser.request).toHaveBeenCalledWith('Use the browser model', controller.signal, {
    conversationId: null,
    lifetime: 'temporary-planner',
    model: null,
    reasoningEffort: null
  });
});

it('fails closed on malformed, oversized, or unknown input', async () => {
  const signal = new AbortController().signal;
  await expect(runBrowserInference({ prompt: '   ' }, signal)).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(runBrowserInference({ prompt: 'x'.repeat(96_001) }, signal)).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(runBrowserInference({ prompt: 'ok', reasoningEffort: 'impossible' }, signal)).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(runBrowserInference({ prompt: 'ok', extra: true }, signal)).rejects.toMatchObject({ code: 'invalid_request' });
  expect(browser.request).not.toHaveBeenCalled();
});

it('normalizes browser transport failures without retrying or falling back to an API', async () => {
  browser.request.mockRejectedValueOnce(new Error('goal_browser_busy'));
  await expect(runBrowserInference({ prompt: 'one shot' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'browser_busy' });
  expect(browser.request).toHaveBeenCalledTimes(1);
});


it('refuses browser inference unless strict chat allowlisting fences the temporary planner from COS tools', async () => {
  policy.strict = false;
  await expect(runBrowserInference({ prompt: 'Do not bypass Codex' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'browser_tools_not_fenced' });
  expect(browser.request).not.toHaveBeenCalled();
});
