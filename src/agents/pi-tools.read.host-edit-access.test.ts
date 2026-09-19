import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { createEditTool } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHostWorkspaceEditTool } from "./pi-tools.read.js";

type CapturedEditOperations = {
  access: (absolutePath: string) => Promise<void>;
};

/**
 * Inject the upstream `createEditTool` boundary so this suite can assert the
 * host workspace access mapping without mocking the pi-coding-agent package at
 * module level (Bun does not support ESM module interception).
 */
function createCapturingEditToolFactory(captured: { operations?: CapturedEditOperations }) {
  return ((_cwd: string, options?: { operations?: CapturedEditOperations }) => {
    captured.operations = options?.operations;
    return {
      name: "edit",
      description: "test edit tool",
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }),
    };
  }) as unknown as typeof createEditTool;
}

describe("createHostWorkspaceEditTool host access mapping", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  (process.platform !== "win32" ? it : it.skip)(
    "silently passes access for outside-workspace paths so readFile reports the real error",
    async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-access-test-"));
      const workspaceDir = path.join(tmpDir, "workspace");
      const outsideDir = path.join(tmpDir, "outside");
      const linkDir = path.join(workspaceDir, "escape");
      const outsideFile = path.join(outsideDir, "secret.txt");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(outsideFile, "secret", "utf8");
      await fs.symlink(outsideDir, linkDir);

      const captured: { operations?: CapturedEditOperations } = {};
      createHostWorkspaceEditTool(workspaceDir, {
        workspaceOnly: true,
        createEditTool: createCapturingEditToolFactory(captured),
      });
      expect(captured.operations).toBeDefined();

      // access must NOT throw for outside-workspace paths; the upstream
      // library replaces any access error with a misleading "File not found".
      // By resolving silently the subsequent readFile call surfaces the real
      // "Path escapes workspace root" / "outside-workspace" error instead.
      await expect(
        captured.operations!.access(path.join(workspaceDir, "escape", "secret.txt")),
      ).resolves.toBeUndefined();
    },
  );
});
