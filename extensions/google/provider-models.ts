import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { cloneFirstTemplateModel } from "openclaw/plugin-sdk/provider-model-shared";

const GOOGLE_GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
const GOOGLE_PROVIDER_PREFIX = "google/";

// --- Model family prefixes ---
const GEMINI_2_5_PRO_PREFIX = "gemini-2.5-pro";
const GEMINI_2_5_FLASH_LITE_PREFIX = "gemini-2.5-flash-lite";
const GEMINI_2_5_FLASH_PREFIX = "gemini-2.5-flash";
const GEMINI_3_1_PRO_PREFIX = "gemini-3.1-pro";
const GEMINI_3_1_FLASH_LITE_PREFIX = "gemini-3.1-flash-lite";
const GEMINI_3_1_FLASH_PREFIX = "gemini-3.1-flash";
const GEMINI_3_FLASH_LITE_PREFIX = "gemini-3-flash-lite";
const GEMINI_3_FLASH_PREFIX = "gemini-3-flash";
const GEMINI_3_5_FLASH_PREFIX = "gemini-3.5-flash";
const GEMMA_PREFIX = "gemma-";

// --- Latest ID aliases ---
const GEMINI_PRO_LATEST_ID = "gemini-pro-latest";
const GEMINI_FLASH_LATEST_ID = "gemini-flash-latest";
const GEMINI_FLASH_LITE_LATEST_ID = "gemini-flash-lite-latest";

// --- Template IDs per family ---
const GEMINI_2_5_PRO_TEMPLATE_IDS = ["gemini-2.5-pro"] as const;
const GEMINI_2_5_FLASH_LITE_TEMPLATE_IDS = ["gemini-2.5-flash-lite"] as const;
const GEMINI_2_5_FLASH_TEMPLATE_IDS = ["gemini-2.5-flash"] as const;
const GEMINI_3_1_PRO_TEMPLATE_IDS = ["gemini-3.1-pro-preview", "gemini-3-pro-preview"] as const;
const GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS = ["gemini-3.1-flash-lite"] as const;
// Compatibility array for persisted 3.1 CLI requests and existing 2.5→3.1
// CLI upgrade behavior.  3.1-flash-preview must remain first to preserve the
// Gemini CLI normalization regression guard (DENNOU_DOCS/2026-03/Week 3/).
const GEMINI_3_1_FLASH_COMPAT_TEMPLATE_IDS = [
  "gemini-3.1-flash-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
] as const;
// Current Flash template for official current model families (3.5/3/Gemma/flash-latest).
// Clones from the current gemini-3-flash-preview catalog row, not the legacy 3.1 row.
const GEMINI_3_FLASH_CURRENT_TEMPLATE_IDS = ["gemini-3-flash-preview", "gemini-2.5-flash"] as const;

type GoogleForwardCompatFamily = {
  googleTemplateIds: readonly string[];
  cliTemplateIds: readonly string[];
  preferExternalFirstForCli?: boolean;
};

type GoogleTemplateSource = {
  templateProviderId: string;
  templateIds: readonly string[];
};

// Intentionally normalizes only the pro/Gemma subset needed during dynamic
// resolution.  Full REST normalization (including 3.1 Flash, 3.1 Flash Lite)
// lives in model-id.ts and is wired on the "google" provider's normalizeModelId
// hook.  This duplication exists because "google-gemini-cli" does not own that
// hook; it only needs these few ID rewrites for template matching.
function normalizeGeminiProRequestId(id: string): string {
  if (id.startsWith(GOOGLE_PROVIDER_PREFIX)) {
    const modelId = id.slice(GOOGLE_PROVIDER_PREFIX.length);
    const normalizedModelId = normalizeGeminiProRequestId(modelId);
    return normalizedModelId === modelId ? id : `${GOOGLE_PROVIDER_PREFIX}${normalizedModelId}`;
  }
  if (id === "gemini-3-pro" || id === "gemini-3-pro-preview" || id === "gemini-3.1-pro") {
    return "gemini-3.1-pro-preview";
  }
  if (id === "gemma-4-26b") {
    return "gemma-4-26b-a4b-it";
  }
  return id;
}

function googleFamilyModelId(id: string): string {
  return id.startsWith(GOOGLE_PROVIDER_PREFIX) ? id.slice(GOOGLE_PROVIDER_PREFIX.length) : id;
}

function cloneGoogleTemplateModel(params: {
  providerId: string;
  modelId: string;
  templateProviderId: string;
  templateIds: readonly string[];
  ctx: ProviderResolveDynamicModelContext;
  patch?: Partial<ProviderRuntimeModel>;
}): ProviderRuntimeModel | undefined {
  return cloneFirstTemplateModel({
    providerId: params.templateProviderId,
    modelId: params.modelId,
    templateIds: params.templateIds,
    ctx: params.ctx,
    patch: {
      ...params.patch,
      provider: params.providerId,
    },
  });
}

function isGoogleGeminiCliProvider(providerId: string): boolean {
  return providerId.trim().toLowerCase() === GOOGLE_GEMINI_CLI_PROVIDER_ID;
}

function templateIdsForProvider(
  templateProviderId: string,
  family: GoogleForwardCompatFamily,
): readonly string[] {
  return isGoogleGeminiCliProvider(templateProviderId)
    ? family.cliTemplateIds
    : family.googleTemplateIds;
}

function buildGoogleTemplateSources(params: {
  providerId: string;
  templateProviderId?: string;
  family: GoogleForwardCompatFamily;
}): GoogleTemplateSource[] {
  const defaultTemplateProviderId = params.templateProviderId?.trim()
    ? params.templateProviderId
    : isGoogleGeminiCliProvider(params.providerId)
      ? "google"
      : GOOGLE_GEMINI_CLI_PROVIDER_ID;
  const preferredExternalFirst =
    isGoogleGeminiCliProvider(params.providerId) &&
    params.family.preferExternalFirstForCli === true;
  const orderedTemplateProviderIds = preferredExternalFirst
    ? [defaultTemplateProviderId, params.providerId]
    : [params.providerId, defaultTemplateProviderId];

  const seen = new Set<string>();
  const sources: GoogleTemplateSource[] = [];
  for (const providerId of orderedTemplateProviderIds) {
    const trimmed = providerId?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    sources.push({
      templateProviderId: trimmed,
      templateIds: templateIdsForProvider(trimmed, params.family),
    });
  }
  return sources;
}

export function resolveGoogleGeminiForwardCompatModel(params: {
  providerId: string;
  templateProviderId?: string;
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const trimmed = normalizeGeminiProRequestId(params.ctx.modelId.trim());
  const lower = googleFamilyModelId(trimmed).toLowerCase();

  let family: GoogleForwardCompatFamily;
  let patch: Partial<ProviderRuntimeModel> | undefined;
  if (lower.startsWith(GEMINI_2_5_PRO_PREFIX)) {
    family = {
      googleTemplateIds: GEMINI_2_5_PRO_TEMPLATE_IDS,
      cliTemplateIds: GEMINI_3_1_PRO_TEMPLATE_IDS,
      preferExternalFirstForCli: true,
    };
  } else if (lower.startsWith(GEMINI_2_5_FLASH_LITE_PREFIX)) {
    family = {
      googleTemplateIds: GEMINI_2_5_FLASH_LITE_TEMPLATE_IDS,
      cliTemplateIds: GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
      preferExternalFirstForCli: true,
    };
  } else if (lower.startsWith(GEMINI_2_5_FLASH_PREFIX)) {
    family = {
      googleTemplateIds: GEMINI_2_5_FLASH_TEMPLATE_IDS,
      cliTemplateIds: GEMINI_3_1_FLASH_COMPAT_TEMPLATE_IDS,
      preferExternalFirstForCli: true,
    };
  } else if (lower.startsWith(GEMINI_3_1_PRO_PREFIX) || lower === GEMINI_PRO_LATEST_ID) {
    family = {
      googleTemplateIds: GEMINI_3_1_PRO_TEMPLATE_IDS,
      cliTemplateIds: GEMINI_3_1_PRO_TEMPLATE_IDS,
    };
    if (params.providerId === "google" || params.providerId === GOOGLE_GEMINI_CLI_PROVIDER_ID) {
      patch = { reasoning: true };
    }
  } else if (
    lower.startsWith(GEMINI_3_1_FLASH_LITE_PREFIX) ||
    lower.startsWith(GEMINI_3_FLASH_LITE_PREFIX) ||
    lower === GEMINI_FLASH_LITE_LATEST_ID
  ) {
    family = {
      googleTemplateIds: GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
      cliTemplateIds: GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
    };
  } else if (lower.startsWith(GEMINI_3_1_FLASH_PREFIX)) {
    // Legacy 3.1 flash: use compatibility array for persisted CLI requests
    family = {
      googleTemplateIds: GEMINI_3_1_FLASH_COMPAT_TEMPLATE_IDS,
      cliTemplateIds: GEMINI_3_1_FLASH_COMPAT_TEMPLATE_IDS,
    };
  } else if (
    lower.startsWith(GEMINI_3_5_FLASH_PREFIX) ||
    lower.startsWith(GEMINI_3_FLASH_PREFIX) ||
    lower === GEMINI_FLASH_LATEST_ID
  ) {
    // Future guard: no official gemini-3.5-flash-lite exists at the pinned
    // upstream SHA (8a2da4b1bf).  If Google introduces one, add a
    // GEMINI_3_5_FLASH_LITE_PREFIX branch above this block before the broad
    // 3.5 Flash match — the prefix ordering already ensures 3.5-flash-lite
    // would win.  Do not invent or support that ID now.
    // Current Flash families: clone from gemini-3-flash-preview catalog row
    family = {
      googleTemplateIds: GEMINI_3_FLASH_CURRENT_TEMPLATE_IDS,
      cliTemplateIds: GEMINI_3_FLASH_CURRENT_TEMPLATE_IDS,
    };
  } else if (lower.startsWith(GEMMA_PREFIX)) {
    // Gemma: clone from current Flash template as forward-compat approximation
    family = {
      googleTemplateIds: GEMINI_3_FLASH_CURRENT_TEMPLATE_IDS,
      cliTemplateIds: GEMINI_3_FLASH_CURRENT_TEMPLATE_IDS,
    };
    if (lower.startsWith("gemma-4")) {
      patch = { reasoning: true };
    }
  } else {
    return undefined;
  }

  for (const source of buildGoogleTemplateSources({
    providerId: params.providerId,
    templateProviderId: params.templateProviderId,
    family,
  })) {
    const model = cloneGoogleTemplateModel({
      providerId: params.providerId,
      modelId: trimmed,
      templateProviderId: source.templateProviderId,
      templateIds: source.templateIds,
      ctx: params.ctx,
      patch,
    });
    if (model) {
      return model;
    }
  }

  return undefined;
}

export function isModernGoogleModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return (
    lower.startsWith("gemini-2.5") ||
    lower.startsWith("gemini-3") ||
    lower === GEMINI_PRO_LATEST_ID ||
    lower === GEMINI_FLASH_LATEST_ID ||
    lower === GEMINI_FLASH_LITE_LATEST_ID ||
    lower.startsWith(GEMMA_PREFIX)
  );
}
