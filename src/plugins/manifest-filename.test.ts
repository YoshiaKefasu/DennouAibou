import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectBundleManifestFormat } from "./bundle-manifest.js";
import {
  loadPluginManifest,
  PLUGIN_MANIFEST_FILENAME,
  PLUGIN_MANIFEST_FILENAMES,
  resolvePluginManifestPath,
} from "./manifest.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-manifest-filename", tempDirs);
}

function writeManifest(dir: string, filename: string, body: unknown) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(body, null, 2), "utf-8");
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("plugin manifest filename resolution", () => {
  it("keeps dennou.plugin.json as the canonical name with openclaw.plugin.json as fallback", () => {
    expect(PLUGIN_MANIFEST_FILENAME).toBe("dennou.plugin.json");
    expect([...PLUGIN_MANIFEST_FILENAMES]).toEqual(["dennou.plugin.json", "openclaw.plugin.json"]);
  });

  it("prefers dennou.plugin.json when both manifests exist", () => {
    const dir = makeTempDir();
    writeManifest(dir, "dennou.plugin.json", { id: "dennou-name", configSchema: {} });
    writeManifest(dir, "openclaw.plugin.json", { id: "legacy-name", configSchema: {} });

    expect(resolvePluginManifestPath(dir)).toBe(path.join(dir, "dennou.plugin.json"));
    const loaded = loadPluginManifest(dir, false);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.manifest.id).toBe("dennou-name");
      expect(loaded.manifestPath).toBe(path.join(dir, "dennou.plugin.json"));
    }
  });

  it("falls back to openclaw.plugin.json when only the legacy manifest exists", () => {
    const dir = makeTempDir();
    writeManifest(dir, "openclaw.plugin.json", { id: "legacy-name", configSchema: {} });

    expect(resolvePluginManifestPath(dir)).toBe(path.join(dir, "openclaw.plugin.json"));
    const loaded = loadPluginManifest(dir, false);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.manifest.id).toBe("legacy-name");
    }
  });

  it("reports the canonical path when no manifest exists", () => {
    const dir = makeTempDir();
    expect(resolvePluginManifestPath(dir)).toBe(path.join(dir, "dennou.plugin.json"));
  });

  it("treats a plugin with dennou.plugin.json as a normal plugin, not a bundle", () => {
    const dir = makeTempDir();
    writeManifest(dir, "dennou.plugin.json", { id: "not-a-bundle", configSchema: {} });
    // A manifestless claude-style layout would otherwise be detected as a bundle.
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });

    expect(detectBundleManifestFormat(dir)).toBeNull();
  });
});

describe("binary plugin manifest fields", () => {
  it("parses executable and tool declarations", () => {
    const dir = makeTempDir();
    writeManifest(dir, "dennou.plugin.json", {
      id: "dennou-voice",
      kind: "binary",
      executable: "./bin/dennou-voice",
      configSchema: { type: "object" },
      tools: [
        {
          name: "voice_call",
          description: "Start a call",
          parameters: { type: "object", properties: { to: { type: "string" } } },
        },
        { name: "   " },
        { name: "voice_hangup" },
      ],
    });

    const loaded = loadPluginManifest(dir, false);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.manifest.kind).toBe("binary");
    expect(loaded.manifest.executable).toBe("./bin/dennou-voice");
    expect(loaded.manifest.tools).toEqual([
      {
        name: "voice_call",
        description: "Start a call",
        parameters: { type: "object", properties: { to: { type: "string" } } },
      },
      { name: "voice_hangup" },
    ]);
  });

  it("omits executable and tools when they are not declared", () => {
    const dir = makeTempDir();
    writeManifest(dir, "dennou.plugin.json", { id: "plain", configSchema: {} });

    const loaded = loadPluginManifest(dir, false);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.manifest.executable).toBeUndefined();
    expect(loaded.manifest.tools).toBeUndefined();
  });
});
