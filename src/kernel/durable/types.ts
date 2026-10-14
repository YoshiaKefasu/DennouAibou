import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { EntryId, SubmissionId } from "@earendil-works/pi-durable";
import type { HarnessOptions } from "@earendil-works/pi-durable";

/** Provider and model ID pair resolved through pi-ai `Models`. */
export type DurableModelRef = {
  readonly provider: string;
  readonly modelId: string;
};

/** What a `DurableKernel` needs to open its durable session. */
export type DurableKernelOptions = {
  /** Directory holding `session.sqlite`; created with mode `0700` when missing. */
  readonly stateDir: string;
  /**
   * pi-ai model access used by generation (`createModels()` + `setProvider()`).
   *
   * Typed with the repo's pinned pi-ai. pi-durable reads the same object through its own pi-ai
   * copy, whose `Models` surface is structurally identical; `create()` bridges the two minor
   * versions with one cast instead of moving the whole repo onto pi-ai 1.2.0.
   */
  readonly models: Models;
  /** Builds a conversation's execution environment at each use; omit for a hermetic kernel. */
  readonly env?: HarnessOptions["env"];
  /** Rendered after every extension section, as the `instructions` section. `undefined` keeps the stored one. */
  readonly systemPrompt?: string;
  /** Model the root conversation runs on. */
  readonly defaultModel: DurableModelRef;
};

/** One host turn: plain text, or multimodal `TextContent | ImageContent` blocks. */
export type DurableTurnInput = {
  readonly text?: string;
  readonly content?: readonly (TextContent | ImageContent)[];
  /** Host-provided deduplication key, scoped to the conversation. */
  readonly requestId?: string;
};

/** One admitted turn, before its answer exists. Only `id` has to survive a restart. */
export type DurableTurnSubmission = {
  readonly id: SubmissionId;
};

/** One tool call observed while a turn ran. */
export type DurableToolResult = {
  readonly name: string;
  /** Text blocks of the tool result, joined with newlines. Image blocks are not flattened into text. */
  readonly output: string;
  readonly isError: boolean;
};

/** Outcome of one finished turn. */
export type DurableTurnResult = {
  /** Text of the assistant entry that answered the turn. */
  readonly answer: string;
  /** Entry ID of the admitted user input, i.e. this turn's place in the transcript. */
  readonly turnId: EntryId;
  readonly toolResults: readonly DurableToolResult[];
};
