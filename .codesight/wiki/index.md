# openclaw — Wiki

_Generated 2026-05-19 — re-run `npx codesight --wiki` if the codebase has changed._

Structural map compiled from source code via AST. No LLM — deterministic, 200ms.

> **How to use safely:** These articles tell you WHERE things live and WHAT exists. They do not show full implementation logic. Always read the actual source files before implementing new features or making changes. Never infer how a function works from the wiki alone.

## Articles

- [Overview](./overview.md)
- [Agents.bindings](./agents.bindings.md)
- [Anthropic-prompt-probe](./anthropic-prompt-probe.md)
- [Bridge-server](./bridge-server.md)
- [Capabilities](./capabilities.md)
- [Cdp.helpers](./cdp.helpers.md)
- [Cdp.test](./cdp.test.md)
- [Chat-meta-shared](./chat-meta-shared.md)
- [Chrome](./chrome.md)
- [Chrome.test](./chrome.test.md)
- [Client](./client.md)
- [Close](./close.md)
- [Core](./core.md)
- [Delivery-context.test](./delivery-context.test.md)
- [Echo-transcript](./echo-transcript.md)
- [Gateway-ws-client](./gateway-ws-client.md)
- [Jsonl-socket.test](./jsonl-socket.test.md)
- [Lab-server](./lab-server.md)
- [Mcp-channels-harness](./mcp-channels-harness.md)
- [Media](./media.md)
- [Media-stream](./media-stream.md)
- [Message-handler](./message-handler.md)
- [Monitor-websocket](./monitor-websocket.md)
- [Monitor.test](./monitor.test.md)
- [Openai-ws-connection](./openai-ws-connection.md)
- [Provider.lifecycle](./provider.lifecycle.md)
- [Realtime-handler](./realtime-handler.md)
- [Realtime-transcription-provider](./realtime-transcription-provider.md)
- [Realtime-voice-provider](./realtime-voice-provider.md)
- [Send](./send.md)
- [Send.test](./send.test.md)
- [Sessions-spawn-hooks.test](./sessions-spawn-hooks.test.md)
- [Templating](./templating.md)
- [Test-helpers.e2e](./test-helpers.e2e.md)
- [Test-helpers.server](./test-helpers.server.md)
- [Types.core](./types.core.md)
- [Libraries](./libraries.md)

## Quick Stats

- Routes: **60**
- Models: **0**
- Components: **0**
- Env vars: **463** required, **1** with defaults

## How to Use

- **New session:** read `index.md` (this file) for orientation — WHERE things are
- **Architecture question:** read `overview.md` (~500 tokens)
- **Domain question:** read the relevant article, then **read those source files**
- **Library question:** read `libraries.md`, then read the listed source files
- **Before implementing anything:** read the source files listed in the article
- **Full source context:** read `.codesight/CODESIGHT.md`

## What the Wiki Does Not Cover

These exist in your codebase but are **not** reflected in wiki articles:
- Routes registered dynamically at runtime (loops, plugin factories, `app.use(dynamicRouter)`)
- Internal routes from npm packages (e.g. Better Auth's built-in `/api/auth/*` endpoints)
- WebSocket and SSE handlers
- Raw SQL tables not declared through an ORM
- Computed or virtual fields absent from schema declarations
- TypeScript types that are not actual database columns
- Routes marked `[inferred]` were detected via regex and may have lower precision
- gRPC, tRPC, and GraphQL resolvers may be partially captured

When in doubt, search the source. The wiki is a starting point, not a complete inventory.

---
_Last compiled: 2026-05-19 · 38 articles · [codesight](https://github.com/Houseofmvps/codesight)_