import { describe, expect, it, vi } from "vitest";
import {
  createReasoningFinalAnswerMessage,
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  it("keeps assistantTexts to the final answer when block replies are disabled", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run",
      reasoningMode: "on",
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Final " });
    emitAssistantTextDelta({ emit, delta: "answer" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = createReasoningFinalAnswerMessage();

    emit({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toEqual(["Final answer"]);
  });
});
