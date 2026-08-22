// Stub: browser extension was removed in DennouAibou debloat.

export type BrowserExecutable = Record<string, unknown>;

export function parseBrowserMajorVersion(..._args: unknown[]): number {
  throw new Error("browser extension removed");
}

export async function readBrowserVersion(..._args: unknown[]): Promise<string> {
  throw new Error("browser extension removed");
}

export function resolveGoogleChromeExecutableForPlatform(..._args: unknown[]): string | undefined {
  throw new Error("browser extension removed");
}
