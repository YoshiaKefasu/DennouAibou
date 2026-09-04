export const memoryExtensionTestRoots = [
  "extensions/memory-core",
  "extensions/memory-lancedb",
  "extensions/session-integrity-guard",
];

export function isMemoryExtensionRoot(root) {
  return memoryExtensionTestRoots.includes(root);
}
