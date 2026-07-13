const ANTIGRAVITY_BARE_PRO_IDS = new Set(["gemini-3-pro", "gemini-3.1-pro", "gemini-3-1-pro"]);
const GOOGLE_PROVIDER_PREFIX = "google/";

export function stripGoogleProviderPrefix(id: string): string {
  return id.startsWith(GOOGLE_PROVIDER_PREFIX) ? id.slice(GOOGLE_PROVIDER_PREFIX.length) : id;
}

export function normalizeGoogleModelId(id: string): string {
  if (id.startsWith(GOOGLE_PROVIDER_PREFIX)) {
    const modelId = stripGoogleProviderPrefix(id);
    const normalizedModelId = normalizeGoogleModelId(modelId);
    return normalizedModelId === modelId ? id : `${GOOGLE_PROVIDER_PREFIX}${normalizedModelId}`;
  }
  if (id === "gemini-3-pro" || id === "gemini-3-pro-preview") {
    return "gemini-3.1-pro-preview";
  }
  if (id === "gemini-3-flash") {
    return "gemini-3-flash-preview";
  }
  // Gemini 3.1 Pro maps to the preview-suffixed id for API compatibility.
  if (id === "gemini-3.1-pro") {
    return "gemini-3.1-pro-preview";
  }
  // Gemini 3.1 Flash Lite graduated to GA on 2026-05-07; the -preview
  // endpoint is deprecated (shutdown 2026-05-25). Map old preview name
  // to the stable GA id.
  if (id === "gemini-3.1-flash-lite-preview") {
    return "gemini-3.1-flash-lite";
  }
  // gemini-3.1-flash and gemini-3.1-flash-preview are legacy aliases that
  // map to the official current gemini-3-flash-preview.  The Google REST
  // provider owns this normalization; Gemini CLI does not call it.
  if (id === "gemini-3.1-flash" || id === "gemini-3.1-flash-preview") {
    return "gemini-3-flash-preview";
  }
  if (id === "gemma-4-26b") {
    return "gemma-4-26b-a4b-it";
  }
  return id;
}

export function normalizeAntigravityModelId(id: string): string {
  if (ANTIGRAVITY_BARE_PRO_IDS.has(id)) {
    return `${id}-low`;
  }
  return id;
}
