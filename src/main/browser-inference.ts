import { z } from 'zod';
import { REASONING_EFFORTS, type ReasoningEffort } from '../shared/session.js';
import { MAX_CHATGPT_MESSAGE_CHARS } from '../shared/user-prompt.js';
import { requestBrowserDecision } from './session/input.js';

export type BrowserInferenceErrorCode =
  | 'invalid_request'
  | 'browser_busy'
  | 'browser_cancelled'
  | 'browser_delivery_unconfirmed'
  | 'browser_failed';

export class BrowserInferenceError extends Error {
  constructor(readonly code: BrowserInferenceErrorCode, message: string) {
    super(message);
    this.name = 'BrowserInferenceError';
  }
}

export interface BrowserInferenceRequest {
  prompt: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}

export interface BrowserInferenceResult {
  text: string;
}

const requestSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_CHATGPT_MESSAGE_CHARS),
  model: z.string().trim().min(1).max(128).nullable().optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable().optional()
}).strict();

function normalize(error: unknown): BrowserInferenceError {
  if (error instanceof BrowserInferenceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'goal_browser_busy') return new BrowserInferenceError('browser_busy', message);
  if (message === 'goal_browser_cancelled') return new BrowserInferenceError('browser_cancelled', message);
  if (message === 'goal_browser_send_unconfirmed') return new BrowserInferenceError('browser_delivery_unconfirmed', message);
  return new BrowserInferenceError('browser_failed', message || 'browser inference failed');
}

/**
 * One stateless inference turn through the browser transport COS already owns.
 *
 * This deliberately creates no agent/runtime/session abstraction. Codex or any other local
 * caller owns its conversation and tool lifecycle; COS owns only the exact temporary browser
 * send and its answer. A fresh Temporary Chat per call prevents two independent histories from
 * becoming competing sources of truth.
 */
export async function runBrowserInference(raw: unknown, signal: AbortSignal): Promise<BrowserInferenceResult> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new BrowserInferenceError('invalid_request', 'browser inference request is invalid');

  try {
    const text = await requestBrowserDecision(parsed.data.prompt, signal, {
      conversationId: null,
      lifetime: 'temporary-planner',
      model: parsed.data.model ?? null,
      reasoningEffort: parsed.data.reasoningEffort ?? null
    });
    return { text };
  } catch (error) {
    throw normalize(error);
  }
}
