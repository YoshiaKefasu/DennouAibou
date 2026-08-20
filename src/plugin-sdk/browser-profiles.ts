// Stub: browser extension was removed in DennouAibou debloat.
// Core sandbox code still references this surface at runtime; calls will throw.

export const DEFAULT_AI_SNAPSHOT_MAX_CHARS = 12000;
export const DEFAULT_BROWSER_DEFAULT_PROFILE_NAME = "default";
export const DEFAULT_BROWSER_EVALUATE_ENABLED = false;
export const DEFAULT_DENNOU_BROWSER_COLOR = "#888";
export const DEFAULT_DENNOU_BROWSER_ENABLED = false;
export const DEFAULT_DENNOU_BROWSER_PROFILE_NAME = "default";
export const DEFAULT_UPLOAD_DIR = "/tmp/uploads";

export function resolveBrowserConfig(..._args: unknown[]): unknown {
  throw new Error("browser extension removed");
}

export function resolveProfile(..._args: unknown[]): unknown {
  throw new Error("browser extension removed");
}

export type ResolvedBrowserConfig = Record<string, unknown>;
export type ResolvedBrowserProfile = Record<string, unknown>;
