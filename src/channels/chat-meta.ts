import { buildChatChannelMetaById, type ChatChannelMeta } from "./chat-meta-shared.js";
import { CHAT_CHANNEL_ORDER, type ChatChannelId } from "./ids.js";

export type { ChatChannelMeta };

// Safe: `buildChatChannelMetaById()` walks the bundled plugin catalog at
// call time, which transitively reaches `src/plugins/discovery.ts` ->
// `roots.ts` -> `utils.ts` `resolveConfigDir` ->
// `infra/home-dir.ts` `resolveRequiredHomeDir` (path.resolve(process.cwd())
// + env reads). On a browser tab those throw
// `ReferenceError: process is not defined` before any UI code runs.
//
// We resolve the meta map lazily inside the exported functions. The
// module-load sentinel is `null` and the catalog is only walked on first
// access from a Node-side caller. Wrapping the resolution in try/catch
// keeps the failure contained (it falls back to an empty record) so the
// browser-shaped environment never sees the throw. ui consumers never call
// `listChatChannels()` / `getChatChannelMeta()`, so the empty fallback is
// harmless.
let CHAT_CHANNEL_META: Record<ChatChannelId, ChatChannelMeta> | null = null;

function resolveChatChannelMeta(): Record<ChatChannelId, ChatChannelMeta> {
  if (CHAT_CHANNEL_META !== null) {
    return CHAT_CHANNEL_META;
  }
  try {
    CHAT_CHANNEL_META = buildChatChannelMetaById();
  } catch {
    // Keep a frozen empty record so subsequent calls in the same
    // browser-shaped environment don't repeatedly walk the catalog and
    // re-throw. The empty record is also safe because `listChatChannels`
    // filters by `CHAT_CHANNEL_ORDER` (which itself falls back to `[]`).
    CHAT_CHANNEL_META = Object.freeze({}) as Record<ChatChannelId, ChatChannelMeta>;
  }
  return CHAT_CHANNEL_META;
}

export function listChatChannels(): ChatChannelMeta[] {
  const meta = resolveChatChannelMeta();
  return CHAT_CHANNEL_ORDER.map((id) => meta[id]);
}

export function getChatChannelMeta(id: ChatChannelId): ChatChannelMeta {
  return resolveChatChannelMeta()[id];
}
