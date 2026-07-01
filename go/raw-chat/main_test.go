package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// testDB creates a temporary in-memory DB for testing.
func testDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	if err := EnsureSchema(db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	return db
}

// testJSONLFile creates a temporary JSONL file with test data.
func testJSONLFile(t *testing.T, lines []string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "test-session.jsonl")
	content := ""
	for _, line := range lines {
		content += line + "\n"
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write test file: %v", err)
	}
	return path
}

func TestSchemaIdempotent(t *testing.T) {
	db := testDB(t)
	defer db.Close()

	// Schema already created by testDB. Call again — should not error.
	if err := EnsureSchema(db); err != nil {
		t.Fatalf("second EnsureSchema failed: %v", err)
	}

	// Verify schema version is set.
	version := GetSchemaVersion(db)
	if version != SchemaVersion {
		t.Fatalf("expected schema version %q, got %q", SchemaVersion, version)
	}
}

func TestSchemaCreatesAllTables(t *testing.T) {
	db := testDB(t)
	defer db.Close()

	tables := []string{"chat_messages", "chat_index_watermarks", "meta"}
	for _, table := range tables {
		var name string
		err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&name)
		if err != nil {
			t.Errorf("table %q not found: %v", table, err)
		}
	}

	// FTS table may not be available, but check if it was created.
	var ftsName string
	err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name='chat_messages_fts'`).Scan(&ftsName)
	if err == nil {
		t.Logf("FTS5 table created successfully")
	} else {
		t.Logf("FTS5 table not created (expected if FTS5 not supported)")
	}
}

func TestIndexBasic(t *testing.T) {
	db := testDB(t)
	defer db.Close()

	now := time.Now().UnixMilli()
	jsonl := []string{
		`{"type":"message","id":"msg-1","timestamp":` + int64Str(now-3000) + `,"message":{"role":"user","content":"Hello world","id":"msg-1"}}`,
		`{"type":"message","id":"msg-2","timestamp":` + int64Str(now-2000) + `,"message":{"role":"assistant","content":"Hi there!","id":"msg-2"}}`,
		`{"type":"message","id":"msg-3","timestamp":` + int64Str(now-1000) + `,"message":{"role":"user","content":"How are you?","id":"msg-3"}}`,
	}

	path := testJSONLFile(t, jsonl)
	indexed, skipped, errors := IndexSessionFile(db, path, "test-agent", "agent:test:telegram:dm:123")

	if indexed != 3 {
		t.Fatalf("expected 3 indexed, got %d", indexed)
	}
	if skipped != 0 {
		t.Fatalf("expected 0 skipped, got %d", skipped)
	}
	if errors != 0 {
		t.Fatalf("expected 0 errors, got %d", errors)
	}

	// Verify count.
	var count int
	db.QueryRow(`SELECT COUNT(*) FROM chat_messages`).Scan(&count)
	if count != 3 {
		t.Fatalf("expected 3 rows, got %d", count)
	}
}

func TestIndexIdempotent(t *testing.T) {
	db := testDB(t)
	defer db.Close()

	now := time.Now().UnixMilli()
	jsonl := []string{
		`{"type":"message","id":"msg-1","timestamp":` + int64Str(now-3000) + `,"message":{"role":"user","content":"Hello","id":"msg-1"}}`,
		`{"type":"message","id":"msg-2","timestamp":` + int64Str(now-2000) + `,"message":{"role":"assistant","content":"Hi","id":"msg-2"}}`,
	}

	path := testJSONLFile(t, jsonl)

	// Index twice.
	indexed1, _, _ := IndexSessionFile(db, path, "test-agent", "")
	indexed2, _, _ := IndexSessionFile(db, path, "test-agent", "")

	if indexed1 != 2 {
		t.Fatalf("first index: expected 2, got %d", indexed1)
	}
	if indexed2 != 0 {
		t.Fatalf("second index: expected 0 (idempotent), got %d", indexed2)
	}

	// Verify no duplicates.
	var count int
	db.QueryRow(`SELECT COUNT(*) FROM chat_messages`).Scan(&count)
	if count != 2 {
		t.Fatalf("expected 2 rows (no duplicates), got %d", count)
	}
}

func TestIndexMalformedLines(t *testing.T) {
	db := testDB(t)
	defer db.Close()

	now := time.Now().UnixMilli()
	jsonl := []string{
		`this is not json`,
		`{"type":"message","id":"msg-1","timestamp":` + int64Str(now) + `,"message":{"role":"user","content":"Valid","id":"msg-1"}}`,
		``, // empty line
		`{"type":"message","id":"msg-2","timestamp":` + int64Str(now) + `,"message":{"role":"assistant","content":"Also valid","id":"msg-2"}}`,
	}

	path := testJSONLFile(t, jsonl)
	indexed, _, errors := IndexSessionFile(db, path, "test-agent", "")

	if indexed != 2 {
		t.Fatalf("expected 2 indexed, got %d", indexed)
	}
	if errors != 1 {
		t.Fatalf("expected 1 error (malformed line), got %d", errors)
	}
}

func TestSearchByKeyword(t *testing.T) {
	db := testDB(t)
	defer db.Close()

	indexTestMessages(t, db)

	results := Search(db, SearchParams{
		Query:   "EJU",
		AgentID: "test-agent",
		Limit:   10,
	})

	if results.Count == 0 {
		t.Fatal("expected results for keyword 'EJU'")
	}

	// Verify results contain the expected text.
	found := false
	for _, r := range results.Results {
		if contains(r.Snippet, "EJU") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected results to contain 'EJU', got: %v", results.Results)
	}
}

func TestSearchByDate(t *testing.T) {
	db := testDB(t)
	defer db.Close()

	indexTestMessages(t, db)

	// Use today's date.
	today := time.Now().UTC().Format("2006-01-02")
	results := Search(db, SearchParams{
		Date:    today,
		AgentID: "test-agent",
		Limit:   10,
	})

	if results.Count == 0 {
		t.Fatal("expected results for today's date")
	}

	// All results should be from today.
	for _, r := range results.Results {
		if r.Timestamp[:10] != today {
			t.Errorf("expected timestamp to start with %s, got %s", today, r.Timestamp)
		}
	}
}

func TestSearchByTimeRange(t *testing.T) {
	db := testDB(t)
	defer db.Close()

	now := time.Now().UTC()
	indexTestMessages(t, db)

	// Search within a narrow time window.
	from := now.Add(-2 * time.Hour).UTC().Format(time.RFC3339)
	to := now.Add(1 * time.Hour).UTC().Format(time.RFC3339)

	results := Search(db, SearchParams{
		From:    from,
		To:      to,
		AgentID: "test-agent",
		Limit:   10,
	})

	if results.Count == 0 {
		t.Fatal("expected results for time range")
	}
}

func TestSearchByRole(t *testing.T) {
	db := testDB(t)
	defer db.Close()

	indexTestMessages(t, db)

	results := Search(db, SearchParams{
		Role:    "user",
		AgentID: "test-agent",
		Limit:   10,
	})

	if results.Count == 0 {
		t.Fatal("expected results for role 'user'")
	}

	for _, r := range results.Results {
		if r.Role != "user" {
			t.Errorf("expected role 'user', got %q", r.Role)
		}
	}
}

func TestSearchByMessageID(t *testing.T) {
	db := testDB(t)
	defer db.Close()

	indexTestMessages(t, db)

	results := Search(db, SearchParams{
		MessageID:     "msg-2",
		AgentID:       "test-agent",
		ContextBefore: 2,
		ContextAfter:  2,
	})

	if results.Count == 0 {
		t.Fatal("expected results for messageId context search")
	}

	// Should include the target message and context.
	if results.Count < 3 {
		t.Errorf("expected at least 3 results (target + context), got %d", results.Count)
	}
}

func TestSearchLimit(t *testing.T) {
	db := testDB(t)
	defer db.Close()

	indexTestMessages(t, db)

	results := Search(db, SearchParams{
		AgentID: "test-agent",
		Limit:   2,
	})

	if results.Count != 2 {
		t.Fatalf("expected 2 results (limit), got %d", results.Count)
	}
}

func TestSearchCombinedKeywordAndDate(t *testing.T) {
	db := testDB(t)
	defer db.Close()

	indexTestMessages(t, db)

	today := time.Now().UTC().Format("2006-01-02")
	results := Search(db, SearchParams{
		Query:   "EJU",
		Date:    today,
		AgentID: "test-agent",
		Limit:   10,
	})

	if results.Count == 0 {
		t.Fatal("expected results for combined keyword + date")
	}
}

func TestSearchEmpty(t *testing.T) {
	db := testDB(t)
	defer db.Close()

	results := Search(db, SearchParams{
		Query:   "nonexistent",
		AgentID: "test-agent",
		Limit:   10,
	})

	if results.Count != 0 {
		t.Fatalf("expected 0 results for nonexistent query, got %d", results.Count)
	}
}

func TestWatermarkUpdate(t *testing.T) {
	db := testDB(t)
	defer db.Close()

	now := time.Now().UnixMilli()
	jsonl := []string{
		`{"type":"message","id":"msg-1","timestamp":` + int64Str(now) + `,"message":{"role":"user","content":"First","id":"msg-1"}}`,
	}

	path := testJSONLFile(t, jsonl)
	IndexSessionFile(db, path, "test-agent", "")

	// Verify watermark exists.
	var lastLine int
	err := db.QueryRow(`SELECT last_line FROM chat_index_watermarks WHERE source_file = ?`, path).Scan(&lastLine)
	if err != nil {
		t.Fatalf("watermark not found: %v", err)
	}
	if lastLine != 1 {
		t.Fatalf("expected last_line=1, got %d", lastLine)
	}
}

// indexTestMessages creates a standard set of test messages.
func indexTestMessages(t *testing.T, db *sql.DB) {
	t.Helper()
	now := time.Now().UnixMilli()
	jsonl := []string{
		`{"type":"message","id":"msg-1","timestamp":` + int64Str(now-5000) + `,"message":{"role":"user","content":"I need to study for EJU math","id":"msg-1"}}`,
		`{"type":"message","id":"msg-2","timestamp":` + int64Str(now-4000) + `,"message":{"role":"assistant","content":"EJU math covers algebra and calculus","id":"msg-2"}}`,
		`{"type":"message","id":"msg-3","timestamp":` + int64Str(now-3000) + `,"message":{"role":"user","content":"What topics should I focus on?","id":"msg-3"}}`,
		`{"type":"message","id":"msg-4","timestamp":` + int64Str(now-2000) + `,"message":{"role":"assistant","content":"Focus on quadratic equations and integrals","id":"msg-4"}}`,
		`{"type":"message","id":"msg-5","timestamp":` + int64Str(now-1000) + `,"message":{"role":"user","content":"Thank you!","id":"msg-5"}}`,
	}

	path := testJSONLFile(t, jsonl)
	indexed, _, _ := IndexSessionFile(db, path, "test-agent", "agent:test:telegram:dm:123")
	if indexed != 5 {
		t.Fatalf("expected 5 indexed, got %d", indexed)
	}
}

func int64Str(n int64) string {
	return fmt.Sprintf("%d", n)
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsImpl(s, substr))
}

func containsImpl(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
