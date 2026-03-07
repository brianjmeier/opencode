# Decisions

## 2026-03-07 - OpenAI Responses WebSocket mode

- Use Bun's native `WebSocket` client with custom headers instead of adding a `ws` dependency. Verified locally with `npx bun@1.3.8`.
- Run project Bun commands with `npx bun@1.3.8` instead of changing the global Bun installation.
- The package build script currently enforces Bun `^1.3.10`, so build validation is run with `npx bun@1.3.10` even though local targeted testing used `npx bun@1.3.8`.
- Keep the implementation in a single module at `packages/opencode/src/provider/websocket.ts` instead of splitting connection/fetch/state across multiple files. This keeps the change smaller and easier to trace.
- Key persistent WebSocket state by `session + provider + model`, not just provider. This avoids cross-session blocking and avoids chaining across model switches.
- Reuse the existing AI SDK OpenAI Responses parser by bridging WebSocket server messages back into an SSE `Response` body inside the custom fetch path.
- Implement warmup inside the WebSocket fetch path, not in the prompt loop. This lets warmup reuse the exact provider-generated `/responses` body, including tools and instructions, without reimplementing OpenAI request shaping.
- For `@ai-sdk/openai-compatible` providers with `provider.options.websocket = true`, switch to the repo's custom OpenAI-compatible provider implementation so `.responses()` is available.
- Treat reconnects conservatively: when the socket reconnects, clear the cached `previous_response_id` chain and rebuild from full context on the next request.
- Treat compaction or prompt-head changes conservatively: when the prompt prefix changes, clear the cached `previous_response_id` chain and rebuild from full context.
