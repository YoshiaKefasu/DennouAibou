export type EmbeddedContextFile = {
  path: string;
  content: string;
  /** Explicit prompt priority (smaller = earlier); falls back to the default order when absent. */
  priority?: number;
};

export type FailoverReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "rate_limit"
  | "overloaded"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "session_expired"
  | "unknown";
