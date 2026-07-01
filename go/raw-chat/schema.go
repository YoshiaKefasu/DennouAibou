package main

import (
	"database/sql"
	"fmt"
)

// Schema version for this implementation.
const SchemaVersion = "1"

// EnsureSchema creates all required tables and indexes if they don't exist.
// This is idempotent — safe to call on every startup.
func EnsureSchema(db *sql.DB) error {
	// Meta table for schema versioning.
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`); err != nil {
		return fmt.Errorf("create meta: %w", err)
	}

	// Main message ledger table.
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS chat_messages (
			id INTEGER PRIMARY KEY,
			stable_key TEXT NOT NULL UNIQUE,
			session_id TEXT NOT NULL,
			session_key TEXT,
			agent_id TEXT NOT NULL,
			channel TEXT,
			message_id TEXT,
			parent_id TEXT,
			role TEXT NOT NULL,
			timestamp_ms INTEGER NOT NULL,
			timestamp_iso TEXT NOT NULL,
			date_key TEXT NOT NULL,
			text TEXT NOT NULL,
			raw_json TEXT NOT NULL,
			source_file TEXT NOT NULL,
			source_line INTEGER NOT NULL,
			indexed_at_ms INTEGER NOT NULL
		)
	`); err != nil {
		return fmt.Errorf("create chat_messages: %w", err)
	}

	// Indexes for efficient queries.
	indexes := []string{
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp_ms)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_date ON chat_messages(date_key)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_channel ON chat_messages(agent_id, channel)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_message_id ON chat_messages(message_id)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_role ON chat_messages(role)`,
	}
	for _, idx := range indexes {
		if _, err := db.Exec(idx); err != nil {
			return fmt.Errorf("create index: %w", err)
		}
	}

	// FTS5 virtual table for keyword search.
	if _, err := db.Exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
			text,
			role UNINDEXED,
			session_id UNINDEXED,
			timestamp_iso UNINDEXED,
			content='chat_messages',
			content_rowid='id',
			tokenize='unicode61'
		)
	`); err != nil {
		// FTS5 may not be available in all builds; log but don't fail.
		// Search will degrade gracefully.
		fmt.Printf("[raw-chat] Warning: FTS5 creation failed (may not be supported): %v\n", err)
	}

	// Watermarks table for incremental indexing.
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS chat_index_watermarks (
			source_file TEXT PRIMARY KEY,
			size_bytes INTEGER NOT NULL,
			mtime_ms INTEGER NOT NULL,
			last_line INTEGER NOT NULL,
			last_indexed_at_ms INTEGER NOT NULL
		)
	`); err != nil {
		return fmt.Errorf("create watermarks: %w", err)
	}

	// Set schema version.
	if _, err := db.Exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`, SchemaVersion); err != nil {
		return fmt.Errorf("set schema version: %w", err)
	}

	return nil
}

// GetSchemaVersion returns the current schema version, or empty string if not set.
func GetSchemaVersion(db *sql.DB) string {
	var version string
	err := db.QueryRow(`SELECT value FROM meta WHERE key = 'schema_version'`).Scan(&version)
	if err != nil {
		return ""
	}
	return version
}
