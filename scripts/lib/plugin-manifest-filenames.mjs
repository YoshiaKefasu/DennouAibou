import fs from "node:fs";
import path from "node:path";

/**
 * Accepted plugin manifest filenames in probe order.
 *
 * Keep this in sync with `PLUGIN_MANIFEST_FILENAMES` in `src/plugins/manifest.ts`:
 * `dennou.plugin.json` is the DennouAibou-native name and `openclaw.plugin.json`
 * stays supported for backwards compatibility.
 */
export const PLUGIN_MANIFEST_FILENAMES = ["dennou.plugin.json", "openclaw.plugin.json"];

/**
 * Returns the manifest filename present in `pluginDir`, or `null` when the
 * directory has no plugin manifest.
 */
export function resolvePluginManifestFilename(pluginDir) {
  for (const filename of PLUGIN_MANIFEST_FILENAMES) {
    if (fs.existsSync(path.join(pluginDir, filename))) {
      return filename;
    }
  }
  return null;
}

/** Absolute path to the manifest that should be written for a source plugin dir. */
export function resolvePluginManifestPath(pluginDir) {
  const filename = resolvePluginManifestFilename(pluginDir) ?? PLUGIN_MANIFEST_FILENAMES[0];
  return path.join(pluginDir, filename);
}
