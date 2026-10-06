import { randomUUID } from 'node:crypto';
import type { AgentRuntime, RuntimeEvent } from './agent-runtime.js';

export interface CodexE2EOptions {
  timeoutMs?: number;
}

export interface CodexE2EResult {
  ok: true;
  output: string;
}

const E2E_TOKEN = 'COS_CODEX_E2E_OK';
const MAX_E2E_OUTPUT_CHARS = 8_192;

export async function verifyCodexRuntimeE2E(
  runtime: AgentRuntime,
  options: CodexE2EOptions = {}
): Promise<CodexE2EResult> {
  if (runtime.kind !== 'codex-app-server') throw new Error('Codex E2E gate requires the codex-app-server runtime');
  const timeoutMs = options.timeoutMs ?? 90_000;
  let sessionId: string | null = null;
  let output = '';
  let settled = false;
  const early: RuntimeEvent[] = [];
  let resolveGate!: () => void;
  let rejectGate!: (error: Error) => void;
  const gate = new Promise<void>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });

  const accept = (event: RuntimeEvent): void => {
    if (settled) return;
    if (!sessionId) {
      early.push(event);
      return;
    }
    if (event.type === 'output-delta' && event.sessionId === sessionId) {
      output = (output + event.text).slice(-MAX_E2E_OUTPUT_CHARS);
      return;
    }
    if (event.type === 'turn-completed' && event.sessionId === sessionId) {
      settled = true;
      resolveGate();
      return;
    }
    if (event.type === 'turn-failed' && event.sessionId === sessionId) {
      settled = true;
      rejectGate(new Error(event.message));
    }
  };
  const drop = runtime.onEvent(accept);
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectGate(new Error('Codex E2E gate timed out before turn/completed'));
  }, timeoutMs);
  timer.unref?.();

  try {
    const session = await runtime.start({
      executionId: randomUUID(),
      input: `Reply with exactly ${E2E_TOKEN} and nothing else.`,
      model: null,
      reasoningEffort: null,
      cwd: null
    });
    if (!session) throw new Error('Codex runtime refused the E2E gate');
    sessionId = session.id;
    for (const event of early.splice(0)) accept(event);
    await gate;
    return { ok: true, output: output.trim() };
  } finally {
    clearTimeout(timer);
    drop();
    if (sessionId) {
      try { await runtime.close(sessionId); } catch { /* best-effort cleanup after the gate */ }
    }
  }
}
