import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent argument forwarding", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("forwards native audio inputs to runEmbeddedAttempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const nativeAudioPaths = ["/tmp/inbound-voice.wav"];
    const nativeAudioTypes = ["audio/wav"];
    const nativeAudioMimeType = "audio/wav";

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hear this",
      nativeAudioPaths,
      nativeAudioTypes,
      nativeAudioMimeType,
      timeoutMs: 30000,
      runId: "run-native-audio-forwarding",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeAudioPaths,
        nativeAudioTypes,
        nativeAudioMimeType,
      }),
    );
  });
});
