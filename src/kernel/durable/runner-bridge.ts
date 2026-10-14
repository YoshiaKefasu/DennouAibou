import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { log } from "../../agents/pi-embedded-runner/logger.js";
import type { RunEmbeddedPiAgentParams } from "../../agents/pi-embedded-runner/run/params.js";
import type {
  EmbeddedPiAgentMeta,
  EmbeddedPiRunResult,
} from "../../agents/pi-embedded-runner/types.js";
import { describeUnknownError } from "../../agents/pi-embedded-runner/utils.js";
import { resolveStateDir } from "../../config/paths.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import { DurableKernel } from "./durable-kernel.js";
import type { DurableTurnInput } from "./types.js";

/** Injectable seams of `runDurableKernelAgent`, following the runner's deps pattern. */
export type RunDurableKernelAgentDeps = {
  /** Directory that holds `session.sqlite`; defaults to `<stateDir>/agents/<agentId>`. */
  resolveSessionStateDir?: (params: RunEmbeddedPiAgentParams) => string;
  /**
   * pi-ai models the kernel generates with.
   *
   * Note: the default `createModels()` registers no providers, so a production
   * `kernel: "durable"` run fails closed with an error payload until the
   * provider/transport wiring (models.json → pi-ai `Provider`) lands with the
   * Phase 3 plugin binding. The seam lets tests inject a faux-provider `Models`.
   */
  createModels?: () => Models;
  /** Clock used for `durationMs`. */
  now?: () => number;
};

/** `<stateDir>/agents/<agentId>`, the directory `DurableKernel` opens `session.sqlite` in. */
function resolveSessionStateDir(params: RunEmbeddedPiAgentParams): string {
  const agentId = params.agentId?.trim() || DEFAULT_AGENT_ID;
  return join(resolveStateDir(process.env), "agents", agentId);
}

/**
 * Runs one Gateway turn through the durable kernel and shapes it as an
 * `EmbeddedPiRunResult` so `runEmbeddedPiAgent` can dispatch to it behind the
 * `agents.defaults.kernel` flag (or `DENNOU_KERNEL=durable`).
 *
 * The kernel is opened, resumed, and closed per turn: admission is committed to
 * SQLite before the turn runs, so a crash mid-generation loses nothing and the
 * next open + `resume()` continues it. Every failure — kernel open, generation,
 * close — is converted into an `isError` payload so the Gateway process never
 * dies inside the bridge.
 */
export async function runDurableKernelAgent(
  params: RunEmbeddedPiAgentParams,
  deps: RunDurableKernelAgentDeps = {},
): Promise<EmbeddedPiRunResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
  const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const agentMeta: EmbeddedPiAgentMeta = {
    sessionId: params.sessionId,
    provider,
    model: modelId,
  };

  if (params.abortSignal?.aborted) {
    return {
      payloads: [{ text: "Operation aborted", isError: true }],
      meta: { durationMs: now() - started, agentMeta, aborted: true },
    };
  }

  let kernel: DurableKernel | undefined;
  try {
    const models = (deps.createModels ?? createModels)();
    kernel = await DurableKernel.create({
      stateDir: (deps.resolveSessionStateDir ?? resolveSessionStateDir)(params),
      models,
      defaultModel: { provider, modelId },
    });
    await kernel.resume();

    // Propagate abortSignal into the Chord context so cancellation works.
    let turnContext: Context = BACKGROUND_CONTEXT;
    if (params.abortSignal) {
      turnContext = withAbortSignal(params.abortSignal, turnContext);
    }
    const result = await kernel.submitTurn(toTurnInput(params), turnContext);

    // Reply notification is best-effort: failure must not turn a successful turn into an error payload.
    await notifyAnswer(params, result.answer);

    return {
      payloads: [{ text: result.answer }],
      meta: { durationMs: now() - started, agentMeta },
    };
  } catch (err) {
    const aborted = params.abortSignal?.aborted === true;
    log.warn(`[durable-kernel] run failed: ${describeUnknownError(err)}`);
    return {
      payloads: [{ text: describeUnknownError(err), isError: true }],
      meta: { durationMs: now() - started, agentMeta, aborted },
    };
  } finally {
    if (kernel) {
      await kernel.close().catch((closeErr: unknown) => {
        log.warn(`[durable-kernel] close failed: ${describeUnknownError(closeErr)}`);
      });
    }
  }
}

/** Prompt plus images as one multimodal turn; plain text when the run carries no images. */
function toTurnInput(params: RunEmbeddedPiAgentParams): DurableTurnInput {
  const images = params.images ?? [];
  if (images.length === 0) {
    return { text: params.prompt };
  }
  return {
    content: [{ type: "text", text: params.prompt }, ...images],
  };
}

/** Push the finished answer to the streaming/block callbacks when the run registered them. */
async function notifyAnswer(params: RunEmbeddedPiAgentParams, answer: string): Promise<void> {
  if (!answer) {
    return;
  }
  try {
    await params.onPartialReply?.({ text: answer });
    await params.onBlockReply?.({ text: answer });
  } catch (notifyErr) {
    log.warn(`[durable-kernel] reply notification failed: ${describeUnknownError(notifyErr)}`);
  }
}
