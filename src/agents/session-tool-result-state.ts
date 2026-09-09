export type PendingToolCall = { id: string; name?: string; preserve?: boolean };

export type PendingToolCallState = {
  size: () => number;
  entries: () => IterableIterator<[string, string | undefined]>;
  getToolName: (id: string) => string | undefined;
  /** True when the tool call requested `preserve: true` (raw result persistence). */
  getPreserve: (id: string) => boolean;
  delete: (id: string) => void;
  clear: () => void;
  trackToolCalls: (calls: PendingToolCall[]) => void;
  getPendingIds: () => string[];
  shouldFlushForSanitizedDrop: () => boolean;
  shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) => boolean;
  shouldFlushBeforeNewToolCalls: (toolCallCount: number) => boolean;
};

export function createPendingToolCallState(): PendingToolCallState {
  const pending = new Map<string, string | undefined>();
  const preserveIds = new Set<string>();

  return {
    size: () => pending.size,
    entries: () => pending.entries(),
    getToolName: (id: string) => pending.get(id),
    getPreserve: (id: string) => preserveIds.has(id),
    delete: (id: string) => {
      pending.delete(id);
      preserveIds.delete(id);
    },
    clear: () => {
      pending.clear();
      preserveIds.clear();
    },
    trackToolCalls: (calls: PendingToolCall[]) => {
      for (const call of calls) {
        pending.set(call.id, call.name);
        if (call.preserve === true) {
          preserveIds.add(call.id);
        }
      }
    },
    getPendingIds: () => Array.from(pending.keys()),
    shouldFlushForSanitizedDrop: () => pending.size > 0,
    shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) =>
      pending.size > 0 && (toolCallCount === 0 || nextRole !== "assistant"),
    shouldFlushBeforeNewToolCalls: (toolCallCount: number) => pending.size > 0 && toolCallCount > 0,
  };
}
