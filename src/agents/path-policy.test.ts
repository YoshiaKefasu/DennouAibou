import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveInputPathMock = vi.hoisted(() => vi.fn());

vi.mock("./input-path.js", () => ({
  resolveInputPath: resolveInputPathMock,
}));

import { toRelativeWorkspacePath } from "./path-policy.js";

describe("toRelativeWorkspacePath (windows semantics)", () => {
  beforeEach(() => {
    resolveInputPathMock.mockReset();
    resolveInputPathMock.mockImplementation((filePath: string) => filePath);
  });

  it("accepts windows paths with mixed separators and case", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const root = "C:\\Users\\User\\OpenClaw";
      const candidate = "c:/users/user/openclaw/memory/log.txt";
      expect(toRelativeWorkspacePath(root, candidate)).toBe("memory\\log.txt");
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("rejects windows paths outside workspace root", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const root = "C:\\Users\\User\\OpenClaw";
      const candidate = "C:\\Users\\User\\Other\\log.txt";
      expect(() => toRelativeWorkspacePath(root, candidate)).toThrow("Path escapes workspace root");
    } finally {
      platformSpy.mockRestore();
    }
  });
});
