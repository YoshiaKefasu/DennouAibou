export const memoryExtensionTestRoots = ["extensions/session-integrity-guard"];

export function isMemoryExtensionRoot(root) {
  return memoryExtensionTestRoots.includes(root);
}
