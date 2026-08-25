import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { resolveProviderRequestPolicyConfig } from "../provider-request-config.js";
import { toHeaderRecord } from "../transport-header-record.js";
import { log } from "./logger.js";

type OpenAIServiceTier = "auto" | "default" | "flex" | "priority";
type OpenAITextVerbosity = "low" | "medium" | "high";

function resolveOpenAIRequestCapabilities(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  compat?: { supportsStore?: boolean };
}) {
  return resolveProviderRequestPolicyConfig({
    provider: typeof model.provider === "string" ? model.provider : undefined,
    api: typeof model.api === "string" ? model.api : undefined,
    baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
    compat: model.compat,
    capability: "llm",
    transport: "stream",
  }).capabilities;
}

function shouldApplyOpenAIAttributionHeaders(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): "openai" | undefined {
  const attributionProvider = resolveOpenAIRequestCapabilities(model).attributionProvider;
  return attributionProvider === "openai" ? attributionProvider : undefined;
}

function normalizeOpenAIServiceTier(value: unknown): OpenAIServiceTier | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "default" ||
    normalized === "flex" ||
    normalized === "priority"
  ) {
    return normalized;
  }
  return undefined;
}

export function resolveOpenAIServiceTier(
  extraParams: Record<string, unknown> | undefined,
): OpenAIServiceTier | undefined {
  const raw = extraParams?.serviceTier ?? extraParams?.service_tier;
  const normalized = normalizeOpenAIServiceTier(raw);
  if (raw !== undefined && normalized === undefined) {
    const rawSummary = typeof raw === "string" ? raw : typeof raw;
    log.warn(`ignoring invalid OpenAI service tier param: ${rawSummary}`);
  }
  return normalized;
}

function normalizeOpenAITextVerbosity(value: unknown): OpenAITextVerbosity | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return undefined;
}

export function resolveOpenAITextVerbosity(
  extraParams: Record<string, unknown> | undefined,
): OpenAITextVerbosity | undefined {
  const raw = extraParams?.textVerbosity ?? extraParams?.text_verbosity;
  const normalized = normalizeOpenAITextVerbosity(raw);
  if (raw !== undefined && normalized === undefined) {
    const rawSummary = typeof raw === "string" ? raw : typeof raw;
    log.warn(`ignoring invalid OpenAI text verbosity param: ${rawSummary}`);
  }
  return normalized;
}

function normalizeOpenAIFastMode(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "on" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "1" ||
    normalized === "fast"
  ) {
    return true;
  }
  if (
    normalized === "off" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "0" ||
    normalized === "normal"
  ) {
    return false;
  }
  return undefined;
}

export function resolveOpenAIFastMode(
  extraParams: Record<string, unknown> | undefined,
): boolean | undefined {
  const raw = extraParams?.fastMode ?? extraParams?.fast_mode;
  const normalized = normalizeOpenAIFastMode(raw);
  if (raw !== undefined && normalized === undefined) {
    const rawSummary = typeof raw === "string" ? raw : typeof raw;
    log.warn(`ignoring invalid OpenAI fast mode param: ${rawSummary}`);
  }
  return normalized;
}

export function createOpenAIAttributionHeadersWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const attributionProvider = shouldApplyOpenAIAttributionHeaders(model);
    if (!attributionProvider) {
      return underlying(model, context, options);
    }
    return underlying(model, context, {
      ...options,
      headers: resolveProviderRequestPolicyConfig({
        provider: attributionProvider,
        api: typeof model.api === "string" ? model.api : undefined,
        baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
        capability: "llm",
        transport: "stream",
        callerHeaders: toHeaderRecord(options?.headers),
        precedence: "defaults-win",
      }).headers,
    });
  };
}
