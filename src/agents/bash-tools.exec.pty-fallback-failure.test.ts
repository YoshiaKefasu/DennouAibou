import { afterEach, expect, test, vi } from "vitest";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { listRunningSessions, resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";

// Inject a fake process supervisor instead of mocking
// `../process/supervisor/index.js` at module level (Bun cannot intercept ESM
// imports).
const supervisorSpawnMock = vi.fn();

const makeSupervisor = (): ProcessSupervisor => {
  const noop = vi.fn();
  return {
    spawn: (...args: unknown[]) => supervisorSpawnMock(...args),
    cancel: noop,
    cancelScope: noop,
    reconcileOrphans: noop,
    getRecord: noop,
  } as unknown as ProcessSupervisor;
};

afterEach(() => {
  resetProcessRegistryForTests();
  vi.clearAllMocks();
});

test("exec cleans session state when PTY fallback spawn also fails", async () => {
  supervisorSpawnMock
    .mockRejectedValueOnce(new Error("pty spawn failed"))
    .mockRejectedValueOnce(new Error("child fallback failed"));

  const tool = createExecTool({
    allowBackground: false,
    host: "gateway",
    security: "full",
    ask: "off",
    execRuntimeDeps: { getProcessSupervisor: makeSupervisor },
  });

  await expect(
    tool.execute("toolcall", {
      command: "echo ok",
      pty: true,
    }),
  ).rejects.toThrow("child fallback failed");

  expect(listRunningSessions()).toHaveLength(0);
});
