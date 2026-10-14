import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  Harness,
  ToolResultEntry,
  createRegistry,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Extension,
  type HarnessOptions,
  type Registry,
  type Submission,
  type UserInput,
} from "@earendil-works/pi-durable";
import { openSessionStorage } from "./storage.js";
import type {
  DurableKernelOptions,
  DurableTurnInput,
  DurableTurnResult,
  DurableTurnSubmission,
  DurableToolResult,
} from "./types.js";

/** Transcript file of one durable session, inside `DurableKernelOptions.stateDir`. */
const SESSION_DB_NAME = "session.sqlite";

/**
 * Thin execution adapter over a `pi-durable` Harness: one root conversation, durable turns, and
 * extensions installed through a registry the Harness keeps reading while it runs.
 *
 * A turn is admitted to storage before it runs, so a crash mid-generation loses nothing: reopen the
 * kernel, call `resume()`, then `waitTurn()` the same submission ID to continue where it stopped.
 * Callers that only ever run in one process can use `submitTurn()`.
 */
export class DurableKernel {
  readonly #harness: Harness;
  readonly #registry: Registry;
  readonly #root: Conversation;
  readonly #defaultContext: Context;
  #closed = false;

  private constructor(
    harness: Harness,
    registry: Registry,
    root: Conversation,
    defaultContext: Context,
  ) {
    this.#harness = harness;
    this.#registry = registry;
    this.#root = root;
    this.#defaultContext = defaultContext;
  }

  /**
   * Open (or reopen) the session in `options.stateDir`.
   *
   * Reopening an existing transcript keeps its stored agent settings: `systemPrompt` only applies
   * when it is given, `defaultModel` when the conversation has none yet. Call `resume()` after
   * `create()` to continue work a previous process left unfinished.
   */
  static async create(options: DurableKernelOptions): Promise<DurableKernel> {
    const context = BACKGROUND_CONTEXT;
    const registry = createRegistry();
    const harness = await Harness.open(
      await openSessionStorage(join(options.stateDir, SESSION_DB_NAME)),
      {
        // pi-ai 1.0.0 (repo pin) vs pi-durable's own 1.2.0 copy: identical surface, so this is a
        // version bridge, not a shape change. See `DurableKernelOptions.models`.
        models: options.models as unknown as HarnessOptions["models"],
        registry,
        env: options.env,
      },
      context,
    );
    const root = await harness.root(context, {
      agent: { model: options.defaultModel, instructions: options.systemPrompt },
    });
    return new DurableKernel(harness, registry, root, context);
  }

  /** Entry ID of the root conversation, for logs and for reopening the same session elsewhere. */
  get rootId(): ConversationId {
    return this.#root.id;
  }

  /** Enable task scheduling, so unfinished tasks of a previous process keep running. Idempotent. */
  async resume(): Promise<void> {
    this.#harness.resume();
  }

  /** Install a plugin or tool extension; it applies to turns admitted from now on. */
  installExtension(extension: Extension): void {
    this.#registry.install(extension);
  }

  /** Admit a turn durably without waiting for its answer. */
  async submit(
    input: DurableTurnInput,
    context: Context = this.#defaultContext,
  ): Promise<DurableTurnSubmission> {
    const submission = await this.#root.submit(
      { type: "input", content: toUserInput(input), requestId: input.requestId },
      context,
    );
    return { id: submission.id };
  }

  /** Wait for a turn admitted by `submit()`, including one admitted before a restart. */
  async waitTurn(
    turn: DurableTurnSubmission,
    context: Context = this.#defaultContext,
  ): Promise<DurableTurnResult> {
    const submission = await this.#harness.submission(turn.id, context);
    if (!submission) throw new Error(`unknown durable turn: ${turn.id}`);
    return await this.#settle(submission, context);
  }

  /** Admit a turn and wait for its answer. */
  async submitTurn(
    input: DurableTurnInput,
    context: Context = this.#defaultContext,
  ): Promise<DurableTurnResult> {
    return await this.waitTurn(await this.submit(input, context), context);
  }

  /** Shut the session down. Idempotent, so a gateway can call it on every exit path. */
  async close(context: Context = this.#defaultContext): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#harness.close(context);
  }

  async #settle(submission: Submission, context: Context): Promise<DurableTurnResult> {
    const settled = await submission.wait(context);
    if (settled.status !== "done") {
      throw new Error(`durable turn ended without an answer (status=${settled.status})`);
    }
    const entryId: EntryId | undefined = settled.entry;
    const answerId: EntryId | undefined = settled.answer;
    if (entryId === undefined || answerId === undefined) {
      throw new Error("durable turn settled without transcript entries");
    }
    const entries = (await this.#root.context(context)).entries;
    return {
      answer: answerText(entries, answerId),
      turnId: entryId,
      toolResults: toolResultsOf(entries, entryId, answerId),
    };
  }
}

function toUserInput(input: DurableTurnInput): UserInput {
  if (input.content !== undefined) return [...input.content];
  if (input.text !== undefined) return input.text;
  throw new Error("a durable turn needs either text or content");
}

/** Text of the assistant entry that answered a turn; empty when the answer carried none. */
function answerText(entries: readonly EntryRecord[], answerId: EntryId): string {
  const entry = entries.find((candidate) => candidate.id === answerId);
  if (!entry || !AssistantEntry.is(entry)) return "";
  return textOf(entry.model);
}

/**
 * Tool results the turn produced, in transcript order.
 *
 * Scoped to the entries between the admitted input and its answer so a turn never reports a tool
 * call of an earlier one. A turn whose input or answer fell out of the active context (compaction)
 * falls back to the whole transcript rather than silently reporting nothing.
 */
function toolResultsOf(
  entries: readonly EntryRecord[],
  entryId: EntryId,
  answerId: EntryId,
): readonly DurableToolResult[] {
  const from = entries.findIndex((candidate) => candidate.id === entryId);
  const to = entries.findIndex((candidate) => candidate.id === answerId);
  const scope = from >= 0 && to > from ? entries.slice(from + 1, to + 1) : entries;
  const results: DurableToolResult[] = [];
  for (const entry of scope) {
    if (!ToolResultEntry.is(entry)) continue;
    for (const message of entry.model ?? []) {
      if (message.role !== "toolResult") continue;
      results.push(toToolResult(message));
    }
  }
  return results;
}

function toToolResult(message: ToolResultMessage): DurableToolResult {
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text);
  return { name: message.toolName, output: text.join("\n"), isError: message.isError };
}

function textOf(
  messages: readonly { readonly role: string; readonly content: unknown }[] | undefined,
): string {
  if (!messages) return "";
  const chunks: string[] = [];
  for (const message of messages) {
    // `content` is an array only for assistant messages; system messages carry a plain string.
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isTextBlock(block)) chunks.push(block.text);
    }
  }
  return chunks.join("");
}

function isTextBlock(block: unknown): block is TextContent {
  if (typeof block !== "object" || block === null) return false;
  const candidate = block as { readonly type?: unknown; readonly text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string";
}
