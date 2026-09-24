import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import {
  resolveAgentDir,
  resolveAgentExplicitModelPrimary,
  resolveAgentModelFallbacksOverride,
} from "../../agents/agent-scope.js";
import {
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
} from "../../agents/model-selection.js";
import { createConfigIO } from "../../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import { getShellEnvAppliedKeys, shouldEnableShellEnvFallback } from "../../infra/shell-env.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { colorize, theme } from "../../terminal/theme.js";
import { shortenHomePath } from "../../utils.js";
import { isRich } from "./list.format.js";
import { loadModelsConfig } from "./load-config.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  ensureFlagCompatibility,
  resolveKnownAgentId,
} from "./shared.js";

export async function modelsStatusCommand(
  opts: {
    json?: boolean;
    plain?: boolean;
    check?: boolean;
    agent?: string;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const configPath = createConfigIO().configPath;
  const cfg = await loadModelsConfig({ commandName: "models status", runtime });
  const agentId = resolveKnownAgentId({ cfg, rawAgentId: opts.agent });
  const agentDir = agentId ? resolveAgentDir(cfg, agentId) : resolveOpenClawAgentDir();
  const agentModelPrimary = agentId ? resolveAgentExplicitModelPrimary(cfg, agentId) : undefined;
  const agentFallbacksOverride = agentId
    ? resolveAgentModelFallbacksOverride(cfg, agentId)
    : undefined;
  const resolved = agentId
    ? resolveDefaultModelForAgent({ cfg, agentId })
    : resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });

  const rawDefaultsModel = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ?? "";
  const rawModel = agentModelPrimary ?? rawDefaultsModel;
  const resolvedLabel = `${resolved.provider}/${resolved.model}`;
  const defaultLabel = rawModel || resolvedLabel;
  const defaultsFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  const fallbacks = agentFallbacksOverride ?? defaultsFallbacks;
  const imageModel = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel) ?? "";
  const imageFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel);
  const aliases = Object.entries(cfg.agents?.defaults?.models ?? {}).reduce<Record<string, string>>(
    (acc, [key, entry]) => {
      const alias = typeof entry?.alias === "string" ? entry.alias.trim() : undefined;
      if (alias) {
        acc[alias] = key;
      }
      return acc;
    },
    {},
  );
  const allowed = Object.keys(cfg.agents?.defaults?.models ?? {});

  const applied = getShellEnvAppliedKeys();
  const shellFallbackEnabled =
    shouldEnableShellEnvFallback(process.env) || cfg.env?.shellEnv?.enabled === true;

  const checkStatus = 0;

  if (opts.json) {
    writeRuntimeJson(runtime, {
      configPath,
      ...(agentId ? { agentId } : {}),
      agentDir,
      defaultModel: defaultLabel,
      resolvedDefault: resolvedLabel,
      fallbacks,
      imageModel: imageModel || null,
      imageFallbacks,
      ...(agentId
        ? {
            modelConfig: {
              defaultSource: agentModelPrimary ? "agent" : "defaults",
              fallbacksSource: agentFallbacksOverride !== undefined ? "agent" : "defaults",
            },
          }
        : {}),
      aliases,
      allowed,
      shellEnvFallback: {
        enabled: shellFallbackEnabled,
        appliedKeys: applied,
      },
    });
    if (opts.check) {
      runtime.exit(checkStatus);
    }
    return;
  }

  if (opts.plain) {
    runtime.log(resolvedLabel);
    if (opts.check) {
      runtime.exit(checkStatus);
    }
    return;
  }

  const rich = isRich(opts);
  type ModelConfigSource = "agent" | "defaults";
  const label = (value: string) => colorize(rich, theme.accent, value.padEnd(14));
  const labelWithSource = (value: string, source?: ModelConfigSource) =>
    label(source ? `${value} (${source})` : value);
  const displayDefault =
    rawModel && rawModel !== resolvedLabel ? `${resolvedLabel} (from ${rawModel})` : resolvedLabel;

  runtime.log(
    `${label("Config")}${colorize(rich, theme.muted, ":")} ${colorize(rich, theme.info, shortenHomePath(configPath))}`,
  );
  runtime.log(
    `${label("Agent dir")}${colorize(rich, theme.muted, ":")} ${colorize(
      rich,
      theme.info,
      shortenHomePath(agentDir),
    )}`,
  );
  runtime.log(
    `${labelWithSource("Default", agentId ? (agentModelPrimary ? "agent" : "defaults") : undefined)}${colorize(
      rich,
      theme.muted,
      ":",
    )} ${colorize(rich, theme.success, displayDefault)}`,
  );
  runtime.log(
    `${labelWithSource(
      `Fallbacks (${fallbacks.length || 0})`,
      agentId ? (agentFallbacksOverride !== undefined ? "agent" : "defaults") : undefined,
    )}${colorize(rich, theme.muted, ":")} ${colorize(
      rich,
      fallbacks.length ? theme.warn : theme.muted,
      fallbacks.length ? fallbacks.join(", ") : "-",
    )}`,
  );
  runtime.log(
    `${labelWithSource("Image model", agentId ? "defaults" : undefined)}${colorize(
      rich,
      theme.muted,
      ":",
    )} ${colorize(rich, imageModel ? theme.accentBright : theme.muted, imageModel || "-")}`,
  );
  runtime.log(
    `${labelWithSource(
      `Image fallbacks (${imageFallbacks.length || 0})`,
      agentId ? "defaults" : undefined,
    )}${colorize(rich, theme.muted, ":")} ${colorize(
      rich,
      imageFallbacks.length ? theme.accentBright : theme.muted,
      imageFallbacks.length ? imageFallbacks.join(", ") : "-",
    )}`,
  );
  runtime.log(
    `${label(`Aliases (${Object.keys(aliases).length || 0})`)}${colorize(rich, theme.muted, ":")} ${colorize(
      rich,
      Object.keys(aliases).length ? theme.accent : theme.muted,
      Object.keys(aliases).length
        ? Object.entries(aliases)
            .map(([alias, target]) =>
              rich
                ? `${theme.accentDim(alias)} ${theme.muted("->")} ${theme.info(target)}`
                : `${alias} -> ${target}`,
            )
            .join(", ")
        : "-",
    )}`,
  );
  runtime.log(
    `${label(`Configured models (${allowed.length || 0})`)}${colorize(rich, theme.muted, ":")} ${colorize(
      rich,
      allowed.length ? theme.info : theme.muted,
      allowed.length ? allowed.join(", ") : "all",
    )}`,
  );

  runtime.log("");
  runtime.log(colorize(rich, theme.heading, "Auth overview"));
  runtime.log(
    `${label("Shell env")}${colorize(rich, theme.muted, ":")} ${colorize(
      rich,
      shellFallbackEnabled ? theme.success : theme.muted,
      shellFallbackEnabled ? "on" : "off",
    )}${applied.length ? colorize(rich, theme.muted, ` (applied: ${applied.join(", ")})`) : ""}`,
  );

  if (opts.check) {
    runtime.exit(checkStatus);
  }
}
