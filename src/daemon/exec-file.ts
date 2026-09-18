import { execFile as nodeExecFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";

export type ExecResult = { stdout: string; stderr: string; code: number };

type ExecFileFn = typeof nodeExecFile;

let execFileImpl: ExecFileFn = nodeExecFile;

/**
 * Test-only override for the `node:child_process` execFile boundary. Tests
 * inject a fixture instead of mocking `node:child_process` at module level,
 * which Bun's runner does not support for ESM imports.
 */
export function setExecFileForTests(impl: ExecFileFn | null): void {
  execFileImpl = impl ?? nodeExecFile;
}

export async function execFileUtf8(
  command: string,
  args: string[],
  options: Omit<ExecFileOptionsWithStringEncoding, "encoding"> = {},
): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve) => {
    execFileImpl(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) {
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code: 0,
        });
        return;
      }

      const e = error as { code?: unknown; message?: unknown };
      const stderrText = String(stderr ?? "");
      resolve({
        stdout: String(stdout ?? ""),
        stderr:
          stderrText ||
          (typeof e.message === "string" ? e.message : typeof error === "string" ? error : ""),
        code: typeof e.code === "number" ? e.code : 1,
      });
    });
  });
}