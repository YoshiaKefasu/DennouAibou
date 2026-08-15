// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/vercel-ai-gateway/api.js");
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "vercel-ai-gateway",
    artifactBasename: "api.js",
  });
}
export const buildVercelAiGatewayProvider: FacadeModule["buildVercelAiGatewayProvider"] = ((
  ...args
) =>
  loadFacadeModule()["buildVercelAiGatewayProvider"](
    ...args,
  )) as FacadeModule["buildVercelAiGatewayProvider"];
export const discoverVercelAiGatewayModels: FacadeModule["discoverVercelAiGatewayModels"] = ((
  ...args
) =>
  loadFacadeModule()["discoverVercelAiGatewayModels"](
    ...args,
  )) as FacadeModule["discoverVercelAiGatewayModels"];
export const getStaticVercelAiGatewayModelCatalog: FacadeModule["getStaticVercelAiGatewayModelCatalog"] =
  ((...args) =>
    loadFacadeModule()["getStaticVercelAiGatewayModelCatalog"](
      ...args,
    )) as FacadeModule["getStaticVercelAiGatewayModelCatalog"];
// Inert constants: never imported by production code (verified 2026-08). The
// extensions/vercel-ai-gateway package is scheduled for removal; these are
// lazy facade proxies so module import does not throw, and only first access
// triggers the (throwing) bundled-surface load. Kept for SDK type-surface
// compatibility only. Do not access.
export const VERCEL_AI_GATEWAY_BASE_URL: FacadeModule["VERCEL_AI_GATEWAY_BASE_URL"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["VERCEL_AI_GATEWAY_BASE_URL"] as object,
  ) as FacadeModule["VERCEL_AI_GATEWAY_BASE_URL"];
export const VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW: FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW"] as object,
  ) as FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW"];
export const VERCEL_AI_GATEWAY_DEFAULT_COST: FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_COST"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["VERCEL_AI_GATEWAY_DEFAULT_COST"] as object,
  ) as FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_COST"];
export const VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS: FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS"] as object,
  ) as FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS"];
export const VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID: FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID"] as object,
  ) as FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID"];
export const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF: FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF"] as object,
  ) as FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF"];
export const VERCEL_AI_GATEWAY_PROVIDER_ID: FacadeModule["VERCEL_AI_GATEWAY_PROVIDER_ID"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["VERCEL_AI_GATEWAY_PROVIDER_ID"] as object,
  ) as FacadeModule["VERCEL_AI_GATEWAY_PROVIDER_ID"];
