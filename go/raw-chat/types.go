package main

import "encoding/json"

// RPC request/response types for raw chat sidecar.
// Follows the same JSON-RPC 2.0 pattern as episodic-core.

// RPCRequest represents an incoming JSON-RPC request.
type RPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	ID      *int            `json:"id,omitempty"`
}

// RPCResponse represents an outgoing JSON-RPC response.
type RPCResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	Result  interface{} `json:"result,omitempty"`
	Error   *RPCError   `json:"error,omitempty"`
	ID      *int        `json:"id,omitempty"`
}

// RPCError represents a JSON-RPC error.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// IndexSessionParams is the params for raw_chat.index_session.
type IndexSessionParams struct {
	SessionFile string `json:"session_file"`
	AgentID     string `json:"agent_id"`
	SessionKey  string `json:"session_key,omitempty"`
}

// IndexSessionResult is the result for raw_chat.index_session.
type IndexSessionResult struct {
	Indexed int `json:"indexed"`
	Skipped int `json:"skipped"`
	Errors  int `json:"errors"`
}

// SearchParams is the params for raw_chat.search.
type SearchParams struct {
	Query         string `json:"query,omitempty"`
	From          string `json:"from,omitempty"`
	To            string `json:"to,omitempty"`
	Date          string `json:"date,omitempty"`
	MessageID     string `json:"message_id,omitempty"`
	Role          string `json:"role,omitempty"`
	AgentID       string `json:"agent_id,omitempty"`
	Channel       string `json:"channel,omitempty"`
	Limit         int    `json:"limit,omitempty"`
	ContextBefore int    `json:"context_before,omitempty"`
	ContextAfter  int    `json:"context_after,omitempty"`
}

// SearchResult represents a single search result.
type SearchResult struct {
	MessageID    string   `json:"message_id,omitempty"`
	SessionID    string   `json:"session_id,omitempty"`
	AgentID      string   `json:"agent_id,omitempty"`
	Channel      string   `json:"channel,omitempty"`
	Role         string   `json:"role"`
	Timestamp    string   `json:"timestamp"`
	Snippet      string   `json:"snippet"`
	Context      []string `json:"context,omitempty"`
}

// SearchResults is the result for raw_chat.search.
type SearchResults struct {
	Results []SearchResult `json:"results"`
	Count   int            `json:"count"`
}

// BackfillParams is the params for raw_chat.backfill.
type BackfillParams struct {
	AgentID   string `json:"agent_id"`
	SessionDir string `json:"session_dir,omitempty"`
}

// BackfillResult is the result for raw_chat.backfill.
type BackfillResult struct {
	TotalFiles    int `json:"total_files"`
	IndexedFiles  int `json:"indexed_files"`
	SkippedFiles  int `json:"skipped_files"`
	TotalMessages int `json:"total_messages"`
	Errors        int `json:"errors"`
}
