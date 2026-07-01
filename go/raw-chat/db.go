package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	_ "github.com/mattn/go-sqlite3"
)

// OpenDB opens or creates the raw chat SQLite DB for a given agent.
// Path: ~/.openclaw/agents/<agentId>/raw-chat.sqlite
func OpenDB(agentID string) (*sql.DB, error) {
	dbPath, err := ResolveDBPath(agentID)
	if err != nil {
		return nil, err
	}

	// Ensure parent directory exists.
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create dir %s: %w", dir, err)
	}

	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", dbPath, err)
	}

	// Ensure schema is up to date.
	if err := EnsureSchema(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("ensure schema: %w", err)
	}

	return db, nil
}

// ResolveDBPath returns the per-agent DB path without opening it.
func ResolveDBPath(agentID string) (string, error) {
	stateDir := os.Getenv("OPENCLAW_STATE_DIR")
	if stateDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home: %w", err)
		}
		stateDir = filepath.Join(home, ".openclaw")
	}
	return filepath.Join(stateDir, "agents", agentID, "raw-chat.sqlite"), nil
}

// OpenDBReadOnly opens an existing DB in read-only mode. Returns nil if not found.
func OpenDBReadOnly(agentID string) (*sql.DB, error) {
	dbPath, err := ResolveDBPath(agentID)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		return nil, nil
	}

	// On Windows, SQLite read-only mode requires immutable=1 or we can just open normally.
	// Using normal open is safer for cross-platform compatibility.
	db, err := sql.Open("sqlite3", dbPath+"?mode=ro&_journal_mode=WAL")
	if err != nil {
		return nil, fmt.Errorf("open read-only %s: %w", dbPath, err)
	}
	return db, nil
}

// IsFts5Available checks if FTS5 is supported in this SQLite build.
func IsFts5Available(db *sql.DB) bool {
	var result string
	err := db.QueryRow(`SELECT sqlite_compileoption_used('ENABLE_FTS5')`).Scan(&result)
	return err == nil && result == "1"
}

func init() {
	// Ensure CGO is enabled for mattn/go-sqlite3.
	if runtime.GOOS == "" {
		// This is just a safety check; the build will fail if CGO is not enabled.
	}
}
