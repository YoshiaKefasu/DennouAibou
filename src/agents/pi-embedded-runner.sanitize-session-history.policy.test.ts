import type { Mock } from "vitest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSanitizeSessionHistoryWithCleanMocks,
  makeMockSessionManager,
  makeSimpleUserMessages,
  type SanitizeSessionHistoryHarness,
  sanitizeSnapshotChangedOpenAIReasoning,
  sanitizeWithOpenAIResponses,
} from "./pi-embedded-runner.sanitize-session-history.test-harness.js";

vi.mock("./pi-embedded-helpers.js", async () => ({
  ...(await import("./pi-embedded-helpers.js")),
  isGoogleModelApi: vi.fn(),
  sanitizeSessionMessagesImages: vi.fn(async (msgs) => msgs),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderRuntimePlugin: vi.fn(() => undefined),
  sanitizeProviderReplayHistoryWithPlugin: vi.fn(() => undefined),
  validateProviderReplayTurnsWithPlugin: vi.fn(() => undefined),
}));

let sanitizeSessionHistory: SanitizeSessionHistoryHarness["sanitizeSessionHistory"];
let mockedHelpers: SanitizeSessionHistoryHarness["mockedHelpers"];

describe("sanitizeSessionHistory e2e smoke", () => {
  const mockSessionManager = makeMockSessionManager();
  const mockMessages = makeSimpleUserMessages();

  beforeAll(async () => {
    const harness = await loadSanitizeSessionHistoryWithCleanMocks();
    sanitizeSessionHistory = harness.sanitizeSessionHistory;
    mockedHelpers = harness.mockedHelpers;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (mockedHelpers.sanitizeSessionMessagesImages as Mock).mockImplementation(async (msgs) => msgs);
  });

  it("passes simple user-only history through for google model APIs", async () => {
    (mockedHelpers.isGoogleModelApi as Mock).mockReturnValue(true);

    const result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "google-generative-ai",
      provider: "google-vertex",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(result).toEqual(mockMessages);
  });

  it("passes simple user-only history through for openai-responses", async () => {
    (mockedHelpers.isGoogleModelApi as Mock).mockReturnValue(false);

    const result = await sanitizeWithOpenAIResponses({
      sanitizeSessionHistory,
      messages: mockMessages,
      sessionManager: mockSessionManager,
    });

    expect(result).toEqual(mockMessages);
  });

  it("downgrades openai reasoning blocks when the model snapshot changed", async () => {
    const result = await sanitizeSnapshotChangedOpenAIReasoning({
      sanitizeSessionHistory,
    });

    expect(result).toEqual([]);
  });
});
