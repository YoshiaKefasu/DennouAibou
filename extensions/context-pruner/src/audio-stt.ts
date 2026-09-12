/**
 * Deferred audio transcription for context-pruner (COMPACTION_FEATURE.md §8.2/§8.3).
 *
 * The worker is deliberately independent from the agent turn. It scans session JSONL
 * files in the background, uploads only old local audio attachments to Groq Whisper,
 * and atomically replaces the attachment representation with text. A missing API key,
 * an unavailable session file, a busy session lock, or a transcription failure is a
 * safe no-op; the next scan can retry it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logSessionCheckin } from "openclaw/plugin-sdk/session-gatekeeper";
import type { SttConfig } from "./pruner.js";

const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 60_000;
const DEFAULT_SCAN_INTERVAL_MS = 5 * 60 * 1_000;
const MIN_SCAN_INTERVAL_MS = 60 * 1_000;
const ACTIVE_SESSION_GRACE_MS = 60 * 1_000;
const SESSION_LOCK_STALE_AFTER_MS = 10 * 60 * 1_000;
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aiff",
  ".alac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
  ".wma",
]);

const AUDIO_MIME_PREFIX = "audio/";
const TRANSCRIPT_PREFIX = "🎙️ [音声文字起こし:";

type JsonRecord = Record<string, unknown>;

export type AudioSttLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type AudioAttachmentTarget = {
  /** Local filesystem path used for the Groq upload and shown in the replacement. */
  path: string;
  mimeType?: string;
  durationSeconds?: number;
  /** Original attachment index when the message has MediaPaths/MediaTypes arrays. */
  attachmentIndex?: number;
  /** Content-array index when the audio is represented as a content block. */
  contentIndex?: number;
  /** Message timestamp used for the age gate. */
  timestampMs: number | null;
};

export type AudioSttScanResult = {
  sessionFile: string;
  candidates: number;
  transcribed: number;
  changed: boolean;
  skipped?:
    | "missing-api-key"
    | "locked"
    | "missing-file"
    | "recently-updated"
    | "concurrent-update"
    | "unsupported-provider";
};

type AudioTranscriber = (target: AudioAttachmentTarget) => Promise<string | undefined>;

type SessionFileScanOptions = {
  sessionFile: string;
  stt: SttConfig;
  gatewayConfig?: unknown;
  env?: NodeJS.ProcessEnv;
  now?: number;
  fetchImpl?: typeof fetch;
  logger?: AudioSttLogger;
  /** Test/runtime seam. When supplied, the Groq HTTP client is not used. */
  transcribeAudio?: AudioTranscriber;
};

export type AudioSttWorkerOptions = {
  stt: SttConfig;
  stateDir: string;
  gatewayConfig?: unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  logger?: AudioSttLogger;
  sessionFiles?: () => Promise<string[]>;
  onSessionTranscriptUpdate?: (sessionFile: string) => void;
};

export type AudioSttWorker = {
  scan: () => Promise<AudioSttScanResult[]>;
  stop: () => void;
};

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function normalizeMimeType(value: unknown): string | undefined {
  const mime = readString(value);
  return mime?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

function isAudioPath(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isAudioMime(mimeType: string | undefined): boolean {
  return mimeType === "audio" || mimeType?.startsWith(AUDIO_MIME_PREFIX) === true;
}

function isRemotePath(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//iu.test(value) && !value.startsWith("file://");
}

function normalizeLocalPath(value: unknown): string | undefined {
  const raw = readString(value);
  if (!raw || isRemotePath(raw)) {
    return undefined;
  }
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw);
    } catch {
      return undefined;
    }
  }
  return raw;
}

function readPathFromRecord(record: JsonRecord): string | undefined {
  for (const key of ["filePath", "mediaPath", "path", "localPath", "filename"]) {
    const localPath = normalizeLocalPath(record[key]);
    if (localPath) {
      return localPath;
    }
  }
  for (const key of ["source", "file", "audio", "input_audio"]) {
    const nested = asRecord(record[key]);
    if (nested) {
      const localPath = readPathFromRecord(nested);
      if (localPath) {
        return localPath;
      }
    }
  }
  return undefined;
}

function resolveDurationSeconds(value: unknown, key: string): number | undefined {
  const number = readPositiveNumber(value);
  if (number === undefined) {
    return undefined;
  }
  if (key.toLowerCase().includes("ms")) {
    return number / 1_000;
  }
  // LINE-style generic `duration` values are milliseconds when they are large.
  return key === "duration" && number > 300 ? number / 1_000 : number;
}

function readDurationSeconds(record: JsonRecord): number | undefined {
  for (const key of [
    "durationSeconds",
    "durationSec",
    "duration_s",
    "durationMs",
    "durationMillis",
    "MediaDurationMs",
    "duration",
    "MediaDuration",
  ]) {
    const duration = resolveDurationSeconds(record[key], key);
    if (duration !== undefined) {
      return duration;
    }
  }
  return undefined;
}

function resolveMessageTimestamp(entry: JsonRecord, message: JsonRecord): number | null {
  return toEpochMs(message.timestamp) ?? toEpochMs(entry.timestamp);
}

function getTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      const record = asRecord(block);
      return readString(record?.text) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function hasTranscriptForPath(message: JsonRecord, filePath: string): boolean {
  const text = getTextFromContent(message.content);
  return text.includes(TRANSCRIPT_PREFIX) && text.includes(`(添付: ${filePath},`);
}

function isTranscribedAttachment(
  message: JsonRecord,
  attachmentIndex: number | undefined,
): boolean {
  if (attachmentIndex === undefined || !Array.isArray(message.MediaUnderstanding)) {
    return false;
  }
  return message.MediaUnderstanding.some((value) => {
    const record = asRecord(value);
    return record?.kind === "audio.transcription" && record.attachmentIndex === attachmentIndex;
  });
}

function isAudioContentBlock(record: JsonRecord): boolean {
  const type = readString(record.type)?.toLowerCase();
  const mime = normalizeMimeType(record.mimeType ?? record.mime ?? record.mediaType);
  if (isAudioMime(mime)) {
    return true;
  }
  return type === "audio" || type === "input_audio" || type === "audio_url";
}

function contentIndexForPath(content: unknown, filePath: string): number | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const [index, block] of content.entries()) {
    const record = asRecord(block);
    if (record && readPathFromRecord(record) === filePath) {
      return index;
    }
    if (typeof record?.text === "string" && record.text.includes(filePath)) {
      return index;
    }
  }
  return undefined;
}

function addTarget(
  targets: Map<string, AudioAttachmentTarget>,
  params: Omit<AudioAttachmentTarget, "timestampMs"> & { timestampMs: number | null },
): void {
  if (
    !params.path ||
    (!isAudioMime(normalizeMimeType(params.mimeType)) && !isAudioPath(params.path))
  ) {
    return;
  }
  const existing = targets.get(params.path);
  if (!existing) {
    targets.set(params.path, {
      ...params,
      mimeType: normalizeMimeType(params.mimeType),
    });
    return;
  }
  targets.set(params.path, {
    ...existing,
    mimeType: existing.mimeType ?? normalizeMimeType(params.mimeType),
    durationSeconds: existing.durationSeconds ?? params.durationSeconds,
    attachmentIndex: existing.attachmentIndex ?? params.attachmentIndex,
    contentIndex: existing.contentIndex ?? params.contentIndex,
  });
}

function collectMediaFieldTargets(
  message: JsonRecord,
  timestampMs: number | null,
  targets: Map<string, AudioAttachmentTarget>,
): void {
  const paths = Array.isArray(message.MediaPaths)
    ? message.MediaPaths
    : typeof message.MediaPath === "string"
      ? [message.MediaPath]
      : [];
  const types = Array.isArray(message.MediaTypes) ? message.MediaTypes : [];
  for (const [index, value] of paths.entries()) {
    const filePath = normalizeLocalPath(value);
    if (!filePath) {
      continue;
    }
    const mimeType = normalizeMimeType(
      types[index] ?? (paths.length === 1 ? message.MediaType : undefined),
    );
    addTarget(targets, {
      path: filePath,
      mimeType,
      durationSeconds: readDurationSeconds(message),
      attachmentIndex: index,
      timestampMs,
    });
  }
}

function collectAttachmentArrayTargets(
  message: JsonRecord,
  timestampMs: number | null,
  targets: Map<string, AudioAttachmentTarget>,
): void {
  for (const field of ["attachments", "media", "audio"]) {
    if (!Array.isArray(message[field])) {
      continue;
    }
    for (const [index, value] of message[field].entries()) {
      const record = asRecord(value);
      if (!record) {
        continue;
      }
      const filePath = readPathFromRecord(record);
      const mimeType = normalizeMimeType(record.mimeType ?? record.mime ?? record.type);
      if (!filePath || (!isAudioMime(mimeType) && !isAudioPath(filePath))) {
        continue;
      }
      addTarget(targets, {
        path: filePath,
        mimeType,
        durationSeconds: readDurationSeconds(record) ?? readDurationSeconds(message),
        attachmentIndex: index,
        timestampMs,
      });
    }
  }
}

function collectContentTargets(
  message: JsonRecord,
  timestampMs: number | null,
  targets: Map<string, AudioAttachmentTarget>,
): void {
  if (Array.isArray(message.content)) {
    for (const [index, value] of message.content.entries()) {
      const record = asRecord(value);
      if (!record || !isAudioContentBlock(record)) {
        continue;
      }
      const filePath = readPathFromRecord(record);
      const mimeType = normalizeMimeType(record.mimeType ?? record.mime ?? record.mediaType);
      if (!filePath) {
        // Inline/base64 audio has no local file that can be sent to the deferred worker.
        continue;
      }
      addTarget(targets, {
        path: filePath,
        mimeType,
        durationSeconds: readDurationSeconds(record) ?? readDurationSeconds(message),
        contentIndex: index,
        timestampMs,
      });
    }
  }

  // Older transcript rows store a textual media note alongside MediaPath. If a
  // row has no structured media fields, recover local audio paths from that note.
  if (targets.size === 0) {
    const text = getTextFromContent(message.content);
    const mediaNotePattern =
      /\[media attached(?: \d+\/\d+)?:\s*([^\]|]+?)(?:\s+\([^)]*\))?(?:\s+\|[^\]]*)?\]/gu;
    for (const match of text.matchAll(mediaNotePattern)) {
      const filePath = normalizeLocalPath(match[1]);
      if (!filePath) {
        continue;
      }
      addTarget(targets, {
        path: filePath,
        mimeType: undefined,
        durationSeconds: readDurationSeconds(message),
        timestampMs,
      });
    }
  }
}

/** Find local, not-yet-transcribed audio attachments in one session entry. */
export function findAudioAttachments(entry: unknown): AudioAttachmentTarget[] {
  const entryRecord = asRecord(entry);
  const message = asRecord(entryRecord?.message);
  if (!entryRecord || !message || message.role !== "user") {
    return [];
  }
  if (readString(message.Transcript)) {
    return [];
  }

  const timestampMs = resolveMessageTimestamp(entryRecord, message);
  const targets = new Map<string, AudioAttachmentTarget>();
  collectMediaFieldTargets(message, timestampMs, targets);
  collectAttachmentArrayTargets(message, timestampMs, targets);
  collectContentTargets(message, timestampMs, targets);

  return [...targets.values()]
    .map((target) => ({
      ...target,
      contentIndex: target.contentIndex ?? contentIndexForPath(message.content, target.path),
    }))
    .filter(
      (target) =>
        !hasTranscriptForPath(message, target.path) &&
        !isTranscribedAttachment(message, target.attachmentIndex),
    );
}

/** Apply the §8.2 age gate. Missing timestamps are intentionally fail-closed. */
export function findEligibleAudioAttachments(params: {
  entry: unknown;
  now: number;
  delayMinutes: number;
}): AudioAttachmentTarget[] {
  const delayMs = Math.max(0, params.delayMinutes) * 60 * 1_000;
  return findAudioAttachments(params.entry).filter(
    (target) => target.timestampMs !== null && params.now - target.timestampMs >= delayMs,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceMediaReference(text: string, filePath: string, replacement: string): string {
  const escapedPath = escapeRegExp(filePath);
  const mediaNote = new RegExp(
    `\\[media attached(?: \\d+\\/\\d+)?:\\s*${escapedPath}(?:\\s+\\([^)]*\\))?(?:\\s+\\|[^\\]]*)?\\]`,
    "u",
  );
  if (mediaNote.test(text)) {
    return text.replace(mediaNote, replacement);
  }
  return text.includes(filePath) ? text.replace(filePath, replacement) : text;
}

function formatDuration(durationSeconds: number | undefined): string {
  if (durationSeconds === undefined || !Number.isFinite(durationSeconds)) {
    return "不明";
  }
  const rounded = Math.max(0, Math.round(durationSeconds * 10) / 10);
  return Number.isInteger(rounded) ? `${rounded}秒` : `${rounded.toFixed(1)}秒`;
}

/** Build the canonical compact representation required by COMPACTION_FEATURE §8.3. */
export function formatAudioTranscript(params: {
  text: string;
  filePath: string;
  durationSeconds?: number;
}): string {
  return `🎙️ [音声文字起こし: "${params.text.trim()}"] (添付: ${params.filePath}, ${formatDuration(params.durationSeconds)})`;
}

/** Replace only the message content; entry id/parentId/timestamp and all other fields stay intact. */
export function replaceAudioTranscriptInEntry(
  entry: unknown,
  target: AudioAttachmentTarget,
  transcript: string,
): unknown {
  const entryRecord = asRecord(entry);
  const message = asRecord(entryRecord?.message);
  const text = transcript.trim();
  if (!entryRecord || !message || !text) {
    return entry;
  }

  const replacement = formatAudioTranscript({
    text,
    filePath: target.path,
    durationSeconds: target.durationSeconds,
  });
  const nextMessage: JsonRecord = { ...message };
  const content = message.content;

  if (Array.isArray(content)) {
    const nextContent = content.slice();
    const index = target.contentIndex ?? contentIndexForPath(content, target.path);
    if (index !== undefined) {
      const block = asRecord(nextContent[index]);
      if (block && typeof block.text === "string") {
        nextContent[index] = {
          ...block,
          text: replaceMediaReference(block.text, target.path, replacement),
        };
      } else {
        nextContent[index] = { type: "text", text: replacement };
      }
    } else {
      nextContent.push({ type: "text", text: replacement });
    }
    nextMessage.content = nextContent;
  } else if (typeof content === "string") {
    const updated = replaceMediaReference(content, target.path, replacement);
    nextMessage.content = updated === content ? `${content}\n\n${replacement}` : updated;
  } else {
    nextMessage.content = replacement;
  }

  const nextEntry = { ...entryRecord, message: nextMessage };
  assertSessionTreeFieldsUnchanged(entryRecord, nextEntry);
  return nextEntry;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function assertSessionTreeFieldsUnchanged(before: JsonRecord, after: JsonRecord): void {
  for (const key of ["type", "id", "parentId", "timestamp", "sessionId"]) {
    if (stableJson(before[key]) !== stableJson(after[key])) {
      throw new Error(`audio-stt: refusing replacement that changes session field ${key}`);
    }
  }
  const beforeMessage = asRecord(before.message);
  const afterMessage = asRecord(after.message);
  for (const key of ["role", "timestamp", "toolCallId", "toolName", "isError"]) {
    if (stableJson(beforeMessage?.[key]) !== stableJson(afterMessage?.[key])) {
      throw new Error(`audio-stt: refusing replacement that changes message field ${key}`);
    }
  }
}

function resolveConfigApiKey(gatewayConfig: unknown): string | undefined {
  const config = asRecord(gatewayConfig);
  const env = asRecord(config?.env);
  const vars = asRecord(env?.vars);
  return readString(vars?.GROQ_API_KEY) ?? readString(env?.GROQ_API_KEY);
}

/** Resolve the already-loaded process env first, then Gateway env.vars as fallback. */
export function resolveGroqApiKey(
  params: {
    gatewayConfig?: unknown;
    env?: NodeJS.ProcessEnv;
  } = {},
): string | undefined {
  return (
    readString(params.env?.GROQ_API_KEY) ??
    readString(process.env.GROQ_API_KEY) ??
    resolveConfigApiKey(params.gatewayConfig)
  );
}

function inferMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    case ".flac":
      return "audio/flac";
    case ".webm":
      return "audio/webm";
    case ".aac":
      return "audio/aac";
    default:
      return "audio/ogg";
  }
}

/** Call the Groq OpenAI-compatible Whisper endpoint for one local audio file. */
export async function transcribeWithGroq(params: {
  filePath: string;
  apiKey: string;
  model: string;
  mimeType?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const buffer = await fs.readFile(params.filePath);
  const form = new FormData();
  const fileName = path.basename(params.filePath) || "audio";
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: params.mimeType ?? inferMimeType(params.filePath) }),
    fileName,
  );
  form.append("model", params.model);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  );
  try {
    const response = await (params.fetchImpl ?? fetch)(GROQ_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${params.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Groq transcription failed with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    const text = readString(asRecord(payload)?.text);
    if (!text) {
      throw new Error("Groq transcription response did not contain text");
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

type SessionFileSnapshot = {
  size: number;
  mtimeMs: number;
};

function snapshotSessionFile(stats: { size: number; mtimeMs: number }): SessionFileSnapshot {
  return { size: stats.size, mtimeMs: stats.mtimeMs };
}

function sessionFileChanged(before: SessionFileSnapshot, after: SessionFileSnapshot): boolean {
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

function isRecentlyUpdated(snapshot: SessionFileSnapshot, now: number): boolean {
  return now - snapshot.mtimeMs < ACTIVE_SESSION_GRACE_MS;
}

async function isStaleSessionFileLock(lockPath: string, now: number): Promise<boolean> {
  let raw: string | undefined;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return true;
    }
    return false;
  }

  const lock = asRecord(
    (() => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return undefined;
      }
    })(),
  );
  const createdAt = toEpochMs(lock?.createdAt);
  if (createdAt !== null) {
    return now - createdAt >= SESSION_LOCK_STALE_AFTER_MS;
  }

  // A crash between O_EXCL creation and metadata write leaves an empty or
  // malformed lock. Its mtime is the only available age signal in that case.
  try {
    const stats = await fs.stat(lockPath);
    return now - stats.mtimeMs >= SESSION_LOCK_STALE_AFTER_MS;
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT";
  }
}

async function acquireSessionFileLock(
  sessionFile: string,
  now = Date.now(),
): Promise<(() => Promise<void>) | null> {
  const lockPath = `${path.resolve(sessionFile)}.lock`;

  // A bounded retry prevents a contended lock from turning into a busy loop,
  // while still allowing one stale lock recovery and its race with another worker.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: fs.FileHandle | undefined;
    let ownsLockPath = false;
    const lockId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      handle = await fs.open(lockPath, "wx");
      ownsLockPath = true;
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(now).toISOString(),
          lockId,
          owner: "context-pruner-audio-stt",
        }),
        "utf8",
      );
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (ownsLockPath) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
      if ((error as { code?: string }).code !== "EEXIST") {
        throw error;
      }
      if (!(await isStaleSessionFileLock(lockPath, now))) {
        return null;
      }
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }

    if (!handle || !ownsLockPath) {
      continue;
    }

    return async () => {
      await handle.close().catch(() => undefined);
      try {
        const currentLock = asRecord(JSON.parse(await fs.readFile(lockPath, "utf8")));
        if (currentLock?.lockId === lockId) {
          await fs.rm(lockPath, { force: true });
        }
      } catch {
        // The lock may already have been recovered or removed by another worker.
      }
    };
  }

  return null;
}

async function atomicWriteSessionFile(
  sessionFile: string,
  content: string,
  expectedSnapshot: SessionFileSnapshot,
): Promise<boolean> {
  const absolute = path.resolve(sessionFile);
  const temporary = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.stt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, "utf8");

    // Check after the temporary file is complete and immediately before rename.
    // The live writer owns the session file, so a changed size/mtime aborts the
    // replacement instead of allowing this worker to overwrite a fresh append.
    let currentSnapshot: SessionFileSnapshot;
    try {
      currentSnapshot = snapshotSessionFile(await fs.stat(absolute));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return false;
      }
      throw error;
    }
    if (sessionFileChanged(expectedSnapshot, currentSnapshot)) {
      return false;
    }

    await fs.rename(temporary, absolute);
    return true;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function transcribeEntry(params: {
  entry: unknown;
  options: SessionFileScanOptions;
  apiKey?: string;
}): Promise<{ entry: unknown; candidates: number; transcribed: number }> {
  const now = params.options.now ?? Date.now();
  const candidates = findEligibleAudioAttachments({
    entry: params.entry,
    now,
    delayMinutes: params.options.stt.delayMinutes,
  });
  let current = params.entry;
  let transcribed = 0;
  for (const target of candidates) {
    try {
      const transcript = params.options.transcribeAudio
        ? await params.options.transcribeAudio(target)
        : params.apiKey
          ? await transcribeWithGroq({
              filePath: target.path,
              apiKey: params.apiKey,
              model: params.options.stt.model,
              mimeType: target.mimeType,
              fetchImpl: params.options.fetchImpl,
            })
          : undefined;
      if (!transcript?.trim()) {
        continue;
      }
      current = replaceAudioTranscriptInEntry(current, target, transcript);
      transcribed += 1;
    } catch (error) {
      params.options.logger?.warn?.(
        `context-pruner: audio transcription skipped for ${target.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { entry: current, candidates: candidates.length, transcribed };
}

/** Scan and, when necessary, atomically rewrite one session JSONL file. */
export async function scanSessionFile(
  options: SessionFileScanOptions,
): Promise<AudioSttScanResult> {
  const baseResult: AudioSttScanResult = {
    sessionFile: options.sessionFile,
    candidates: 0,
    transcribed: 0,
    changed: false,
  };
  if (options.stt.provider !== "groq") {
    return { ...baseResult, skipped: "unsupported-provider" };
  }

  const apiKey = options.transcribeAudio
    ? undefined
    : resolveGroqApiKey({ gatewayConfig: options.gatewayConfig, env: options.env });
  if (!options.transcribeAudio && !apiKey) {
    return { ...baseResult, skipped: "missing-api-key" };
  }

  const now = options.now ?? Date.now();
  let initialSnapshot: SessionFileSnapshot;
  try {
    initialSnapshot = snapshotSessionFile(await fs.stat(options.sessionFile));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { ...baseResult, skipped: "missing-file" };
    }
    throw error;
  }
  if (isRecentlyUpdated(initialSnapshot, now)) {
    return { ...baseResult, skipped: "recently-updated" };
  }

  const release = await acquireSessionFileLock(options.sessionFile, now);
  if (!release) {
    return { ...baseResult, skipped: "locked" };
  }

  try {
    let raw: string;
    let readSnapshot: SessionFileSnapshot;
    try {
      // Recheck after acquiring the lock so an append that happened while the
      // lock was being created is treated as an active-session skip as well.
      readSnapshot = snapshotSessionFile(await fs.stat(options.sessionFile));
      if (isRecentlyUpdated(readSnapshot, now)) {
        return { ...baseResult, skipped: "recently-updated" };
      }
      raw = await fs.readFile(options.sessionFile, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return { ...baseResult, skipped: "missing-file" };
      }
      throw error;
    }

    const newline = raw.includes("\r\n") ? "\r\n" : "\n";
    const lines = raw.split(/\r?\n/u);
    let changed = false;
    let candidates = 0;
    let transcribed = 0;
    let sessionId = path.basename(options.sessionFile, path.extname(options.sessionFile));
    const rewritten = [] as string[];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        rewritten.push(line);
        continue;
      }
      let entry: unknown;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        rewritten.push(line);
        continue;
      }
      const entryRecord = asRecord(entry);
      if (
        entryRecord?.type === "session" &&
        typeof entryRecord.id === "string" &&
        entryRecord.id.trim().length > 0
      ) {
        sessionId = entryRecord.id.trim();
      }
      const result = await transcribeEntry({ entry, options, apiKey });
      candidates += result.candidates;
      transcribed += result.transcribed;
      if (result.transcribed === 0) {
        rewritten.push(line);
        continue;
      }
      changed = true;
      rewritten.push(JSON.stringify(result.entry));
    }

    if (changed) {
      const written = await atomicWriteSessionFile(
        options.sessionFile,
        rewritten.join(newline),
        readSnapshot,
      );
      if (!written) {
        return {
          ...baseResult,
          candidates,
          transcribed: 0,
          changed: false,
          skipped: "concurrent-update",
        };
      }
      try {
        logSessionCheckin({
          actor: "audio-stt",
          action: "rewrite",
          op: `audio-stt-${Date.now()}-${transcribed}`,
          lines: transcribed,
          sessionId,
        });
      } catch {
        // Phase A logging is best-effort and must not affect transcription.
      }
    }
    return { ...baseResult, candidates, transcribed, changed };
  } finally {
    await release();
  }
}

async function discoverSessionFilesFromStateDir(stateDir: string): Promise<string[]> {
  const agentsDir = path.join(stateDir, "agents");
  let agentEntries;
  try {
    agentEntries = await fs.readdir(agentsDir, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) {
      continue;
    }
    const sessionsDir = path.join(agentsDir, agentEntry.name, "sessions");
    let sessionEntries;
    try {
      sessionEntries = await fs.readdir(sessionsDir, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const sessionEntry of sessionEntries) {
      if (
        sessionEntry.isFile() &&
        sessionEntry.name.endsWith(".jsonl") &&
        !sessionEntry.name.includes(".bak.") &&
        !sessionEntry.name.includes(".repair-") &&
        !sessionEntry.name.includes(".stt-")
      ) {
        files.push(path.join(sessionsDir, sessionEntry.name));
      }
    }
  }
  return files.toSorted();
}

export async function discoverSessionFiles(stateDir: string): Promise<string[]> {
  return await discoverSessionFilesFromStateDir(stateDir);
}

async function scanWorkerFiles(options: AudioSttWorkerOptions): Promise<AudioSttScanResult[]> {
  const files = options.sessionFiles
    ? await options.sessionFiles()
    : await discoverSessionFilesFromStateDir(options.stateDir);
  const results: AudioSttScanResult[] = [];
  for (const sessionFile of files) {
    try {
      const result = await scanSessionFile({
        sessionFile,
        stt: options.stt,
        gatewayConfig: options.gatewayConfig,
        env: options.env,
        fetchImpl: options.fetchImpl,
        logger: options.logger,
      });
      results.push(result);
      if (result.changed) {
        options.onSessionTranscriptUpdate?.(sessionFile);
      }
    } catch (error) {
      options.logger?.warn?.(
        `context-pruner: session audio scan failed for ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return results;
}

/** Start a non-blocking periodic worker. The returned stop function is idempotent. */
export function startAudioSttWorker(options: AudioSttWorkerOptions): () => void {
  let stopped = false;
  let scanInFlight = false;
  const intervalMs = Math.max(
    MIN_SCAN_INTERVAL_MS,
    Math.min(
      DEFAULT_SCAN_INTERVAL_MS,
      Math.max(MIN_SCAN_INTERVAL_MS, options.stt.delayMinutes * 60 * 1_000),
    ),
  );

  const run = (): void => {
    if (stopped || scanInFlight) {
      return;
    }
    scanInFlight = true;
    void scanWorkerFiles(options)
      .catch((error) => {
        options.logger?.warn?.(
          `context-pruner: background audio scan failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        scanInFlight = false;
      });
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}

export const AUDIO_STT_DEFAULTS = {
  provider: "groq",
  model: "whisper-large-v3-turbo",
  delayMinutes: 30,
} as const;

export const AUDIO_STT_GROQ_ENDPOINT = GROQ_TRANSCRIPTIONS_URL;
