import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { RuntimeEnv } from "../../runtime.js";
import { applyDefaultModelPrimaryUpdate, type ModelsCommandsDeps, updateConfig } from "./shared.js";

export async function modelsSetCommand(
  modelRaw: string,
  runtime: RuntimeEnv,
  deps?: ModelsCommandsDeps,
) {
  const update = deps?.updateConfig ?? updateConfig;
  const updated = await update((cfg) => {
    return applyDefaultModelPrimaryUpdate({ cfg, modelRaw, field: "model" });
  });

  logConfigUpdated(runtime);
  runtime.log(
    `Default model: ${resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? modelRaw}`,
  );
}
