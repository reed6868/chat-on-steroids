export interface CodexWebProviderRequest {
  model: string;
  stream?: boolean;
  input: unknown[];
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string } | null;
}

export type BrowserEnvelope =
  | { type: 'message'; text: string }
  | { type: 'tool_calls'; calls: Array<{ kind: 'function'; name: string; namespace?: string; arguments: Record<string, unknown> } | { kind: 'custom'; name: string; namespace?: string; input: string }> };

export function buildBrowserPrompt(request: CodexWebProviderRequest, nonce: string): string;
export function parseBrowserEnvelope(text: string, nonce: string, tools?: unknown[]): BrowserEnvelope;
export function responseEvents(envelope: BrowserEnvelope, responseId: string): Array<Record<string, any>>;
export function inferViaCos(request: CodexWebProviderRequest, options?: Record<string, unknown>): Promise<BrowserEnvelope>;
export function createProviderServer(options?: Record<string, unknown>): import('node:http').Server;
