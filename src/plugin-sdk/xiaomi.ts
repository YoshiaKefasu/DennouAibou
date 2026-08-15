// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/xiaomi/api.js");
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "xiaomi",
    artifactBasename: "api.js",
  });
}
export const applyXiaomiConfig: FacadeModule["applyXiaomiConfig"] = ((...args) =>
  loadFacadeModule()["applyXiaomiConfig"](...args)) as FacadeModule["applyXiaomiConfig"];
export const applyXiaomiProviderConfig: FacadeModule["applyXiaomiProviderConfig"] = ((...args) =>
  loadFacadeModule()["applyXiaomiProviderConfig"](
    ...args,
  )) as FacadeModule["applyXiaomiProviderConfig"];
export const buildXiaomiProvider: FacadeModule["buildXiaomiProvider"] = ((...args) =>
  loadFacadeModule()["buildXiaomiProvider"](...args)) as FacadeModule["buildXiaomiProvider"];
// Inert constants: never imported by production code (verified 2026-08). The
// extensions/xiaomi package is scheduled for removal; these are lazy facade
// proxies so module import does not throw, and only first access triggers the
// (throwing) bundled-surface load. Kept for SDK type-surface compatibility
// only. Do not access.
export const XIAOMI_DEFAULT_MODEL_ID: FacadeModule["XIAOMI_DEFAULT_MODEL_ID"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["XIAOMI_DEFAULT_MODEL_ID"] as object,
  ) as FacadeModule["XIAOMI_DEFAULT_MODEL_ID"];
export const XIAOMI_DEFAULT_MODEL_REF: FacadeModule["XIAOMI_DEFAULT_MODEL_REF"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["XIAOMI_DEFAULT_MODEL_REF"] as object,
  ) as FacadeModule["XIAOMI_DEFAULT_MODEL_REF"];
