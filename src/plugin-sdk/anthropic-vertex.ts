// Concrete implementation, ported from the removed anthropic-vertex extension
// (git show HEAD:extensions/anthropic-vertex/region.ts).
//
// The keep-live production path calls these two functions at runtime
// (src/agents/anthropic-vertex-stream.ts via createAnthropicVertexStreamFnForModel),
// so the loader-facade pattern cannot serve them anymore: the bundled plugin
// surface is gone and loadBundledPluginPublicSurfaceModuleSync() throws.
// Imports are re-pointed at kept modules (src/plugin-sdk/provider-http.ts and
// src/utils/normalize-secret-input.ts).
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { resolveProviderEndpoint } from "./provider-http.js";

const ANTHROPIC_VERTEX_DEFAULT_REGION = "global";
const ANTHROPIC_VERTEX_REGION_RE = /^[a-z0-9-]+$/;
const GCLOUD_DEFAULT_ADC_PATH = join(
  homedir(),
  ".config",
  "gcloud",
  "application_default_credentials.json",
);

type AdcProjectFile = {
  project_id?: unknown;
  quota_project_id?: unknown;
};

function resolveAnthropicVertexRegion(env: NodeJS.ProcessEnv = process.env): string {
  const region =
    normalizeOptionalSecretInput(env.GOOGLE_CLOUD_LOCATION) ||
    normalizeOptionalSecretInput(env.CLOUD_ML_REGION);

  return region && ANTHROPIC_VERTEX_REGION_RE.test(region)
    ? region
    : ANTHROPIC_VERTEX_DEFAULT_REGION;
}

export function resolveAnthropicVertexProjectId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    normalizeOptionalSecretInput(env.ANTHROPIC_VERTEX_PROJECT_ID) ||
    normalizeOptionalSecretInput(env.GOOGLE_CLOUD_PROJECT) ||
    normalizeOptionalSecretInput(env.GOOGLE_CLOUD_PROJECT_ID) ||
    resolveAnthropicVertexProjectIdFromAdc(env)
  );
}

function resolveAnthropicVertexRegionFromBaseUrl(baseUrl?: string): string | undefined {
  const endpoint = resolveProviderEndpoint(baseUrl);
  return endpoint.endpointClass === "google-vertex" ? endpoint.googleVertexRegion : undefined;
}

export function resolveAnthropicVertexClientRegion(params?: {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return (
    resolveAnthropicVertexRegionFromBaseUrl(params?.baseUrl) ||
    resolveAnthropicVertexRegion(params?.env)
  );
}

function resolveAnthropicVertexDefaultAdcPath(env: NodeJS.ProcessEnv = process.env): string {
  return platform() === "win32"
    ? join(
        env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
        "gcloud",
        "application_default_credentials.json",
      )
    : GCLOUD_DEFAULT_ADC_PATH;
}

function resolveAnthropicVertexAdcCredentialsPathCandidate(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = normalizeOptionalSecretInput(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (explicit) {
    return explicit;
  }
  if (env !== process.env) {
    return undefined;
  }
  return resolveAnthropicVertexDefaultAdcPath(env);
}

function resolveAnthropicVertexProjectIdFromAdc(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const credentialsPath = resolveAnthropicVertexAdcCredentialsPathCandidate(env);
  if (!credentialsPath) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, "utf8")) as AdcProjectFile;
    return (
      normalizeOptionalSecretInput(parsed.project_id) ||
      normalizeOptionalSecretInput(parsed.quota_project_id)
    );
  } catch {
    return undefined;
  }
}
