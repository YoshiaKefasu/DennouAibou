// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/openrouter/api.js");
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "openrouter",
    artifactBasename: "api.js",
  });
}
export const applyOpenrouterConfig: FacadeModule["applyOpenrouterConfig"] = ((...args) =>
  loadFacadeModule()["applyOpenrouterConfig"](...args)) as FacadeModule["applyOpenrouterConfig"];
export const applyOpenrouterProviderConfig: FacadeModule["applyOpenrouterProviderConfig"] = ((
  ...args
) =>
  loadFacadeModule()["applyOpenrouterProviderConfig"](
    ...args,
  )) as FacadeModule["applyOpenrouterProviderConfig"];
export const buildOpenrouterProvider: FacadeModule["buildOpenrouterProvider"] = ((...args) =>
  loadFacadeModule()["buildOpenrouterProvider"](
    ...args,
  )) as FacadeModule["buildOpenrouterProvider"];
// Inert constant: never imported by production code (verified 2026-08). The
// extensions/openrouter package is scheduled for removal; this is a lazy
// facade proxy so module import does not throw, and only first access triggers
// the (throwing) bundled-surface load. Kept for SDK type-surface compatibility
// only. Do not access.
export const OPENROUTER_DEFAULT_MODEL_REF: FacadeModule["OPENROUTER_DEFAULT_MODEL_REF"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["OPENROUTER_DEFAULT_MODEL_REF"] as object,
  ) as FacadeModule["OPENROUTER_DEFAULT_MODEL_REF"];
