# Routes

- `GET` `/sandbox/novnc` params() [auth, cache]
- `POST` `/api/messages` params() [auth, payment] ✓
- `GET` `/media/:id` params(id) [queue] ✓

## WebSocket Events

- `WS` `error` — `extensions/browser/src/browser/cdp.helpers.ts`
- `WS` `message` — `extensions/browser/src/browser/cdp.helpers.ts`
- `WS` `close` — `extensions/browser/src/browser/cdp.helpers.ts`
- `WS` `message` — `extensions/browser/src/browser/cdp.test.ts`
- `WS` `message` — `extensions/browser/src/browser/chrome.test.ts`
- `WS` `message` — `extensions/browser/src/browser/chrome.ts`
- `WS` `error` — `extensions/discord/src/monitor/provider.lifecycle.ts`
- `WS` `close` — `extensions/discord/src/monitor/provider.lifecycle.ts`
- `WS` `open` — `extensions/mattermost/src/mattermost/monitor-websocket.ts`
- `WS` `message` — `extensions/mattermost/src/mattermost/monitor-websocket.ts`
- `WS` `close` — `extensions/mattermost/src/mattermost/monitor-websocket.ts`
- `WS` `error` — `extensions/mattermost/src/mattermost/monitor-websocket.ts`
- `WS` `#${name}` — `extensions/mattermost/src/mattermost/send.ts`
- `WS` `error` — `extensions/msteams/src/monitor.test.ts`
- `WS` `close` — `extensions/msteams/src/monitor.test.ts`
- `WS` `open` — `extensions/openai/realtime-transcription-provider.ts`
- `WS` `message` — `extensions/openai/realtime-transcription-provider.ts`
- `WS` `error` — `extensions/openai/realtime-transcription-provider.ts`
- `WS` `close` — `extensions/openai/realtime-transcription-provider.ts`
- `WS` `open` — `extensions/openai/realtime-voice-provider.ts`
- `WS` `message` — `extensions/openai/realtime-voice-provider.ts`
- `WS` `error` — `extensions/openai/realtime-voice-provider.ts`
- `WS` `close` — `extensions/openai/realtime-voice-provider.ts`
- `WS` `error` — `extensions/qa-lab/src/lab-server.ts`
- `WS` `close` — `extensions/qa-lab/src/lab-server.ts`
- `WS` `Hello!` — `extensions/twitch/src/send.test.ts`
- `WS` `message` — `extensions/voice-call/src/media-stream.ts`
- `WS` `close` — `extensions/voice-call/src/media-stream.ts`
- `WS` `error` — `extensions/voice-call/src/media-stream.ts`
- `WS` `message` — `extensions/voice-call/src/webhook/realtime-handler.ts`
- `WS` `close` — `extensions/voice-call/src/webhook/realtime-handler.ts`
- `WS` `close` — `scripts/anthropic-prompt-probe.ts`
- `WS` `message` — `scripts/dev/gateway-ws-client.ts`
- `WS` `message` — `scripts/e2e/mcp-channels-harness.ts`
- `WS` `error` — `src/agents/openai-ws-connection.ts`
- `WS` `close` — `src/agents/openai-ws-connection.ts`
- `WS` `message` — `src/agents/openai-ws-connection.ts`
- `WS` `${channelLabel}` — `src/agents/sessions-spawn-hooks.test.ts`
- `WS` `D…` — `src/auto-reply/templating.ts`
- `WS` `close` — `src/canvas-host/server.ts`
- `WS` `${params.id}` — `src/channels/chat-meta-shared.ts`
- `WS` `D…` — `src/channels/plugins/types.core.ts`
- `WS` `${channelRaw}` — `src/commands/agents.bindings.ts`
- `WS` `${rawChannel}` — `src/commands/channels/capabilities.ts`
- `WS` `open` — `src/gateway/client.ts`
- `WS` `message` — `src/gateway/client.ts`
- `WS` `close` — `src/gateway/client.ts`
- `WS` `error` — `src/gateway/client.ts`
- `WS` `message` — `src/gateway/server/ws-connection/message-handler.ts`
- `WS` `message` — `src/gateway/test-helpers.e2e.ts`
- `WS` `message` — `src/gateway/test-helpers.server.ts`
- `WS` `data` — `src/infra/jsonl-socket.test.ts`
- `WS` `end` — `src/infra/jsonl-socket.test.ts`
- `WS` `${String(normalizedChannel)}` — `src/media-understanding/echo-transcript.ts`
- `WS` `${params.id}` — `src/plugin-sdk/core.ts`
- `WS` `,
        to: ` — `src/utils/delivery-context.test.ts`
- `WS` `,
        lastTo: ` — `src/utils/delivery-context.test.ts`
