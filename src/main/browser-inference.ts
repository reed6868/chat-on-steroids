import type { ReasoningEffort } from '../shared/session.js';
import { requestBrowserDecision } from './session/input.js';

export interface BrowserInferenceRequest {
  prompt: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  signal: AbortSignal;
}

/**
 * One stateless ChatGPT Web inference.
 *
 * The browser decision path already owns startup, send ambiguity, exact browser ownership and
 * temporary-tab retirement. This wrapper deliberately adds no session identity or recovery model.
 */
export function inferWithChatGPTBrowser(request: BrowserInferenceRequest): Promise<string> {
  return requestBrowserDecision(request.prompt, request.signal, {
    conversationId: null,
    lifetime: 'temporary-planner',
    model: request.model,
    reasoningEffort: request.reasoningEffort
  });
}
