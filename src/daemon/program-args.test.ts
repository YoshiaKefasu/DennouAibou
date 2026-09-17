import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveGatewayProgramArguments, type ProgramArgsDeps } from "./program-args.js";

const EXEC_PATH = "/usr/local/bin/node";

function createAccess(existing: readonly string[]) {
  return vi.fn(async (target: string) => {
    if (existing.includes(target)) {
      return;
    }
    throw new Error(`missing: ${target}`);
  });
}

describe("resolveGatewayProgramArguments", () => {
  it("uses realpath-resolved dist entry when running via npx shim", async () => {
    const argv1 = path.resolve("/tmp/.npm/_npx/63c3/node_modules/.bin/openclaw");
    const entryPath = path.resolve("/tmp/.npm/_npx/63c3/node_modules/openclaw/dist/entry.js");
    const deps: ProgramArgsDeps = {
      argv: ["node", argv1],
      execPath: EXEC_PATH,
      platform: "linux",
      realpath: vi.fn(async () => entryPath),
      access: createAccess([entryPath]),
    };

    const result = await resolveGatewayProgramArguments({ port: 18789 }, deps);

    expect(result.programArguments).toEqual([EXEC_PATH, entryPath, "gateway", "--port", "18789"]);
  });

  it("prefers symlinked path over realpath for stable service config", async () => {
    // Simulates pnpm global install where node_modules/openclaw is a symlink
    // to .pnpm/openclaw@X.Y.Z/node_modules/openclaw
    const symlinkPath = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/entry.js",
    );
    const realpathResolved = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/.pnpm/openclaw@2026.1.21-2/node_modules/openclaw/dist/entry.js",
    );
    const deps: ProgramArgsDeps = {
      argv: ["node", symlinkPath],
      execPath: EXEC_PATH,
      platform: "linux",
      realpath: vi.fn(async () => realpathResolved),
      access: vi.fn(async () => undefined), // Both paths exist
    };

    const result = await resolveGatewayProgramArguments({ port: 18789 }, deps);

    // Should use the symlinked path, not the realpath-resolved versioned path
    expect(result.programArguments[1]).toBe(symlinkPath);
    expect(result.programArguments[1]).not.toContain("@2026.1.21-2");
  });

  it("falls back to node_modules package dist when .bin path is not resolved", async () => {
    const argv1 = path.resolve("/tmp/.npm/_npx/63c3/node_modules/.bin/openclaw");
    const indexPath = path.resolve("/tmp/.npm/_npx/63c3/node_modules/openclaw/dist/index.js");
    const deps: ProgramArgsDeps = {
      argv: ["node", argv1],
      execPath: EXEC_PATH,
      platform: "linux",
      realpath: vi.fn(async () => {
        throw new Error("no realpath");
      }),
      access: createAccess([indexPath]),
    };

    const result = await resolveGatewayProgramArguments({ port: 18789 }, deps);

    expect(result.programArguments).toEqual([EXEC_PATH, indexPath, "gateway", "--port", "18789"]);
  });

  it("uses src/entry.ts for bun dev mode", async () => {
    const repoIndexPath = path.resolve("/repo/src/index.ts");
    const repoEntryPath = path.resolve("/repo/src/entry.ts");
    const execFileSync = vi.fn(() => "/usr/local/bin/bun\n");
    const deps: ProgramArgsDeps = {
      argv: ["/usr/local/bin/node", repoIndexPath],
      execPath: EXEC_PATH,
      platform: "linux",
      realpath: vi.fn(async () => repoIndexPath),
      access: vi.fn(async () => undefined),
      execFileSync,
    };

    const result = await resolveGatewayProgramArguments(
      {
        dev: true,
        port: 18789,
        runtime: "bun",
      },
      deps,
    );

    expect(result.programArguments).toEqual([
      "/usr/local/bin/bun",
      repoEntryPath,
      "gateway",
      "--port",
      "18789",
    ]);
    expect(result.workingDirectory).toBe(path.resolve("/repo"));
  });
});
