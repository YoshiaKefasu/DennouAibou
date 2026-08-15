// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/litellm/api.js");
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "litellm",
    artifactBasename: "api.js",
  });
}
export const applyLitellmConfig: FacadeModule["applyLitellmConfig"] = ((...args) =>
  loadFacadeModule()["applyLitellmConfig"](...args)) as FacadeModule["applyLitellmConfig"];
export const applyLitellmProviderConfig: FacadeModule["applyLitellmProviderConfig"] = ((...args) =>
  loadFacadeModule()["applyLitellmProviderConfig"](
    ...args,
  )) as FacadeModule["applyLitellmProviderConfig"];
export const buildLitellmModelDefinition: FacadeModule["buildLitellmModelDefinition"] = ((
  ...args
) =>
  loadFacadeModule()["buildLitellmModelDefinition"](
    ...args,
  )) as FacadeModule["buildLitellmModelDefinition"];
// Inert constants: never imported by production code (verified 2026-08). The
// extensions/litellm package is scheduled for removal; these are lazy facade
// proxies so module import does not throw, and only first access triggers the
// (throwing) bundled-surface load. Kept for SDK type-surface compatibility
// only. Do not access.
export const LITELLM_BASE_URL: FacadeModule["LITELLM_BASE_URL"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()["LITELLM_BASE_URL"] as object,
) as FacadeModule["LITELLM_BASE_URL"];
export const LITELLM_DEFAULT_MODEL_ID: FacadeModule["LITELLM_DEFAULT_MODEL_ID"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["LITELLM_DEFAULT_MODEL_ID"] as object,
  ) as FacadeModule["LITELLM_DEFAULT_MODEL_ID"];
export const LITELLM_DEFAULT_MODEL_REF: FacadeModule["LITELLM_DEFAULT_MODEL_REF"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["LITELLM_DEFAULT_MODEL_REF"] as object,
  ) as FacadeModule["LITELLM_DEFAULT_MODEL_REF"];
