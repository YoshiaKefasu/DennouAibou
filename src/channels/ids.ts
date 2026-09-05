import { listChannelCatalogEntries } from "../plugins/channel-catalog-registry.js";

export type ChatChannelId = string;

type BundledChatChannelEntry = {
  id: ChatChannelId;
  aliases: readonly string[];
  order: number;
};

function normalizeChannelKey(raw?: string | null): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  return normalized || undefined;
}

function listBundledChatChannelEntries(): BundledChatChannelEntry[] {
  return listChannelCatalogEntries({ origin: "bundled" })
    .flatMap(({ channel }) => {
      const id = normalizeChannelKey(channel.id);
      if (!id) {
        return [];
      }
      const aliases = (channel.aliases ?? [])
        .map((alias) => normalizeChannelKey(alias))
        .filter((alias): alias is string => Boolean(alias));
      return [
        {
          id,
          aliases,
          order: typeof channel.order === "number" ? channel.order : Number.MAX_SAFE_INTEGER,
        },
      ];
    })
    .toSorted(
      (left, right) =>
        left.order - right.order || left.id.localeCompare(right.id, "en", { sensitivity: "base" }),
    );
}

// Safe: the bundled channel catalog walks `src/plugins/discovery.ts` at module
// load to enumerate known channels. That walks `roots.ts` -> `utils.ts`
// `resolveConfigDir` -> `infra/home-dir.ts` `resolveRequiredHomeDir`, both of
// which call `path.resolve(process.cwd())` and read env vars eagerly. On a
// browser tab those throw `ReferenceError: process is not defined` before any
// UI code runs. Wrapping the eager evaluation in a try/catch falls back to
// `[]` so the chain still resolves cleanly. Node-only callers get the real
// catalog on first use; ui consumers do not actually read this list, so the
// fallback sentinel is safe.
const BUNDLED_CHAT_CHANNEL_ENTRIES: readonly BundledChatChannelEntry[] = Object.freeze(
  (() => {
    try {
      return listBundledChatChannelEntries();
    } catch {
      return [] as BundledChatChannelEntry[];
    }
  })(),
);
const CHAT_CHANNEL_ID_SET = new Set(BUNDLED_CHAT_CHANNEL_ENTRIES.map((entry) => entry.id));

export const CHAT_CHANNEL_ORDER = Object.freeze(
  BUNDLED_CHAT_CHANNEL_ENTRIES.map((entry) => entry.id),
);

export const CHANNEL_IDS = CHAT_CHANNEL_ORDER;

export const CHAT_CHANNEL_ALIASES: Record<string, ChatChannelId> = Object.freeze(
  Object.fromEntries(
    BUNDLED_CHAT_CHANNEL_ENTRIES.flatMap((entry) =>
      entry.aliases.map((alias) => [alias, entry.id] as const),
    ),
  ),
) as Record<string, ChatChannelId>;

export function listChatChannelAliases(): string[] {
  return Object.keys(CHAT_CHANNEL_ALIASES);
}

export function normalizeChatChannelId(raw?: string | null): ChatChannelId | null {
  const normalized = normalizeChannelKey(raw);
  if (!normalized) {
    return null;
  }
  const resolved = CHAT_CHANNEL_ALIASES[normalized] ?? normalized;
  return CHAT_CHANNEL_ID_SET.has(resolved) ? resolved : null;
}
