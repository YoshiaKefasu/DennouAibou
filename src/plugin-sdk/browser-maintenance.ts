// Stub: browser extension was removed in DennouAibou debloat.

export type BrowserMaintenanceDeps = {
  closeTrackedBrowserTabsForSessions?: (params: {
    sessionKeys: string[];
    onWarn?: (message: string) => void;
  }) => Promise<void>;
  movePathToTrash?: (targetPath: string) => Promise<void>;
};

async function browserExtensionRemoved(): Promise<void> {
  throw new Error("browser extension removed");
}

export async function closeTrackedBrowserTabsForSessions(
  params: { sessionKeys: string[]; onWarn?: (message: string) => void },
  deps?: BrowserMaintenanceDeps,
): Promise<void> {
  const impl = deps?.closeTrackedBrowserTabsForSessions ?? browserExtensionRemoved;
  return impl(params);
}

export async function movePathToTrash(
  targetPath: string,
  deps?: BrowserMaintenanceDeps,
): Promise<void> {
  const impl = deps?.movePathToTrash ?? browserExtensionRemoved;
  return impl(targetPath);
}
