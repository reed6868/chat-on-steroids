# Codex → COS → ChatGPT Web provider

This optional adapter keeps the execution owner in Codex and uses Chat On Steroids only as the
browser inference transport.

```
Codex agent/tool loop
        |
        | OpenAI Responses-compatible HTTP
        v
scripts/codex-cos-web-provider.mjs
        |
        | authenticated loopback control API
        v
COS requestBrowserDecision()
        |
        v
ChatGPT Temporary Chat
```

It does **not** start Codex from COS, create a Codex runtime in COS, hold a ChatGPT Plan OAuth
token, or call an OpenAI inference endpoint. Codex still owns shell, file edits, approvals,
sandboxing, tool results and conversation history. Each inference request uses a fresh Temporary
Chat, so there is no durable Codex-thread ↔ ChatGPT-conversation mapping.

## Prerequisites

In COS, enable the Local Control API, its **Allow actions** switch, and **Trust only selected
chats** (strict chat allowlisting). Browser inference fails closed unless strict allowlisting is
enabled: the Temporary Chat is an inference surface only, and any attempt by it to call COS tools
must be refused by the existing kernel before Codex can remain the sole executor.

The adapter reads the per-launch COS endpoint and token from the control API directory on every
request, so a COS restart does not require copying its token into Codex.

Set three environment variables before starting the adapter:

- `COS_CONTROL_API_DIR`: the directory containing COS `control-api/endpoint.json` and
  `control-api/token`.
- `COS_WEB_PROVIDER_TOKEN`: a separate secret shared only between Codex and this loopback
  adapter.
- optionally `COS_WEB_MODEL` and `COS_WEB_REASONING` to override the model/effort requested
  by Codex.

Start the adapter:

```sh
npm run codex:web-provider
```

It listens on `127.0.0.1:8061` by default. Use `COS_WEB_PROVIDER_PORT` or `--port` to change
that.

## Codex profile

Use a dedicated `CODEX_HOME` for this profile and do not sign that profile into ChatGPT or
configure an OpenAI API key. This prevents account routing from becoming an accidental fallback.

Example `config.toml`:

```toml
model = "gpt-5.6-sol"
model_provider = "cos-web"
model_context_window = 16000
model_auto_compact_token_limit = 12000

[model_providers.cos-web]
name = "COS ChatGPT Web"
base_url = "http://127.0.0.1:8061/v1"
env_key = "COS_WEB_PROVIDER_TOKEN"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false

[model_providers.cos-web.capabilities]
external_web_access = false
remote_compaction = "unsupported"
```

The 16k context value is deliberately conservative. COS currently bounds one browser-authored
message to 96,000 characters. The adapter refuses an oversized framed request instead of silently
dropping history; Codex should compact locally.

## Security and failure behavior

The provider binds loopback only, requires its own Bearer token, rejects browser-originated
requests, and forwards inference only to COS's authenticated loopback control API. Browser output
must be one nonce-bound JSON object. A tool call is accepted only if that exact tool was declared
by Codex in the current request. Current Responses Lite models such as `gpt-5.6-sol` publish their
live tool set in the first developer `additional_tools` input item instead of the top-level
`tools` field; the adapter recognizes that current prefix but never treats older tool declarations
later in history as authority. Tool execution remains in Codex.

There is no API fallback. If COS is unavailable, ChatGPT Web is busy, the browser send is
ambiguous, the output envelope is invalid, or the request exceeds the browser bound, the Codex
inference request fails visibly.
