/**
 * Type definitions for raw chat SQLite permanent index & search.
 */

export interface ChatMessageRecord {
  id?: number;
  stable_key: string;
  session_id: string;
  session_key?: string | null;
  agent_id: string;
  channel?: string | null;
  message_id?: string | null;
  parent_id?: string | null;
  role: string;
  timestamp_ms: number;
  timestamp_iso: string;
  date_key: string;
  text: string;
  raw_json: string;
  source_file: string;
  source_line: number;
  metadata_json?: string | null;
  indexed_at_ms: number;
}

export interface WatermarkRecord {
  source_file: string;
  size_bytes: number;
  mtime_ms: number;
  last_line: number;
  last_indexed_at_ms: number;
}

export interface SearchParams {
  query?: string;
  from?: string;
  to?: string;
  date?: string;
  message_id?: string;
  role?: string;
  agent_id?: string;
  channel?: string;
  limit?: number;
  context_before?: number;
  context_after?: number;
}

export interface SearchResult {
  message_id?: string;
  session_id?: string;
  agent_id?: string;
  channel?: string;
  role: string;
  timestamp: string;
  snippet: string;
  context?: string[];
}

export interface SearchResults {
  results: SearchResult[];
  count: number;
}

export interface IndexSessionParams {
  session_file: string;
  agent_id: string;
  session_key?: string;
}

export interface IndexSessionResult {
  indexed: number;
  skipped: number;
  errors: number;
}

export interface BackfillParams {
  agent_id: string;
  session_dir?: string;
}

export interface BackfillResult {
  total_files: number;
  indexed_files: number;
  skipped_files: number;
  total_messages: number;
  errors: number;
}

export interface RawChatMessageInput {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string | number;
  message?: {
    role?: string;
    content?: unknown;
    id?: string;
    parentId?: string | null;
    timestamp?: string | number;
    metadata?: Record<string, unknown>;
  };
  [key: string]: unknown;
}
