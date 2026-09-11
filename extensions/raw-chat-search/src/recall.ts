import { getRawChatDatabase } from "./database.js";
import { embedTextWithGeminiOrNull } from "./embedding-client.js";
import { cosineSimilarityBatch } from "./vector-math.js";

export const HIGH_RELEVANCE_THRESHOLD = 0.85;
export const MEDIUM_RELEVANCE_THRESHOLD = 0.6;
export const DEFAULT_RECALL_TIMEOUT_MS = 400;
export const DEFAULT_CONTEXT_WINDOW_ROUNDS = 2;

export type RecallOptions = {
  highThreshold?: number;
  mediumThreshold?: number;
  timeoutMs?: number;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

export type RecallResult = {
  recalled: boolean;
  type: "verbatim" | "hint" | "none";
  injectedContext?: string;
  bestScore: number;
  matchedIds: number[];
};

type RecallMessage = {
  id: number;
  role: string;
  timestampIso: string;
  text: string;
};

const MAX_HINT_MATCHES = 5;
const MAX_CONTEXT_MESSAGES = DEFAULT_CONTEXT_WINDOW_ROUNDS * 2 + 1;

function noRecall(): RecallResult {
  return {
    recalled: false,
    type: "none",
    bestScore: 0,
    matchedIds: [],
  };
}

function normalizeThreshold(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatTimestamp(timestampIso: string): string {
  const parsed = new Date(timestampIso);
  return Number.isNaN(parsed.getTime()) ? timestampIso : parsed.toISOString().slice(0, 10);
}

function escapeXmlText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatContextMessage(message: RecallMessage): string {
  const normalizedRole = message.role.toLowerCase();
  const role =
    normalizedRole === "assistant" ? "Kasou" : normalizedRole === "user" ? "User" : normalizedRole;
  return `${role} (${formatTimestamp(message.timestampIso)}): ${escapeXmlText(message.text.trim())}`;
}

function formatVerbatimContext(messages: readonly RecallMessage[], score: number): string {
  const firstId = messages[0]?.id ?? 0;
  const lastId = messages[messages.length - 1]?.id ?? firstId;
  const quotedMessages = messages.map(formatContextMessage).join("\n");
  return `<recalled-memory type="verbatim" relevance="high">
[過去の記憶: 関連度 ${Math.round(score * 100)}% — ID: ${firstId}-${lastId} より引用]
${quotedMessages}
...（この会話には前後に続きがあります。詳細が必要な場合は \`chat_search\` ツールで ID 範囲を指定して確認できます）
</recalled-memory>`;
}

function formatHintContext(ids: readonly number[]): string {
  return `<recalled-memory type="hint" relevance="medium">
[記憶のヒント: この話題に関連する過去の会話が ${ids.length} 件見つかりました (ID: ${ids.join(", ")})。必要に応じて \`chat_search\` ツールで確認できます]
</recalled-memory>`;
}

function resolveMatchedIds(
  messageIds: readonly number[],
  scores: Float32Array,
  mediumThreshold: number,
): number[] {
  return messageIds
    .map((messageId, index) => ({ messageId, score: scores[index] ?? Number.NEGATIVE_INFINITY }))
    .filter(({ score }) => score >= mediumThreshold)
    .sort((left, right) => right.score - left.score || left.messageId - right.messageId)
    .slice(0, MAX_HINT_MATCHES)
    .map(({ messageId }) => messageId);
}

function resolveBestIndex(scores: Float32Array): number {
  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < scores.length; index++) {
    const score = scores[index] ?? Number.NEGATIVE_INFINITY;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

export async function performVectorRecall(params: {
  prompt: string;
  agentId?: string;
  sessionId?: string;
  options?: RecallOptions;
}): Promise<RecallResult> {
  const prompt = params.prompt.trim();
  if (prompt.length <= 2) {
    return noRecall();
  }

  const options = params.options ?? {};
  const highThreshold = normalizeThreshold(options.highThreshold, HIGH_RELEVANCE_THRESHOLD);
  const mediumThreshold = normalizeThreshold(options.mediumThreshold, MEDIUM_RELEVANCE_THRESHOLD);
  if (mediumThreshold >= highThreshold) {
    return noRecall();
  }

  let queryVector: Float32Array | null;
  try {
    queryVector = await embedTextWithGeminiOrNull(prompt, {
      apiKey: options.apiKey,
      env: options.env,
      timeoutMs: options.timeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS,
      fetchImpl: options.fetchImpl,
    });
  } catch {
    // Keep the direct function fail-open too; the hook is not the only caller.
    return noRecall();
  }
  if (!queryVector) {
    return noRecall();
  }

  const db = getRawChatDatabase(params.agentId, options.env ?? process.env);
  const embeddings = db.loadAllEmbeddings(params.sessionId);
  if (embeddings.count === 0 || embeddings.dim === 0 || queryVector.length < embeddings.dim) {
    return noRecall();
  }

  const scores = new Float32Array(embeddings.count);
  cosineSimilarityBatch(queryVector, embeddings.vectors, embeddings.count, embeddings.dim, scores);

  const bestIndex = resolveBestIndex(scores);
  if (bestIndex < 0) {
    return noRecall();
  }

  const bestScore = scores[bestIndex] ?? 0;
  if (bestScore < mediumThreshold) {
    return { ...noRecall(), bestScore };
  }

  const matchedIds = resolveMatchedIds(embeddings.messageIds, scores, mediumThreshold);
  if (bestScore < highThreshold) {
    if (matchedIds.length === 0) {
      return { ...noRecall(), bestScore };
    }
    return {
      recalled: true,
      type: "hint",
      injectedContext: formatHintContext(matchedIds),
      bestScore,
      matchedIds,
    };
  }

  const context = db
    .selectRecallContext({
      messageId: embeddings.messageIds[bestIndex]!,
      contextBefore: DEFAULT_CONTEXT_WINDOW_ROUNDS,
      contextAfter: DEFAULT_CONTEXT_WINDOW_ROUNDS,
    })
    .slice(0, MAX_CONTEXT_MESSAGES);
  if (context.length === 0) {
    return { ...noRecall(), bestScore, matchedIds };
  }

  return {
    recalled: true,
    type: "verbatim",
    injectedContext: formatVerbatimContext(context, bestScore),
    bestScore,
    matchedIds: [embeddings.messageIds[bestIndex]!],
  };
}
