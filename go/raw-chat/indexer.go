package main

import (
	"bufio"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// JsonlRecord represents a single JSONL line from a session file.
type JsonlRecord struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Timestamp int64  `json:"timestamp"`
	Message   *struct {
		Role      string      `json:"role"`
		Content   interface{} `json:"content"`
		ID        string      `json:"id"`
		ParentID  string      `json:"parentId"`
		Timestamp int64       `json:"timestamp"`
	} `json:"message"`
}

// WatermarkRow represents the indexing progress for a single JSONL file.
type WatermarkRow struct {
	SourceFile      string
	SizeBytes       int64
	MtimeMs         int64
	LastLine        int
	LastIndexedAtMs int64
}

// IndexSessionFile indexes a session JSONL file incrementally.
// Uses watermarks to only process new lines.
// Returns counts of indexed, skipped, and errored records.
func IndexSessionFile(db *sql.DB, sourceFile string, agentID string, sessionKey string) (indexed, skipped, errors int) {
	stat, err := os.Stat(sourceFile)
	if err != nil {
		return 0, 0, 0
	}

	// Check watermark.
	wm := getWatermark(db, sourceFile)
	if wm != nil && wm.SizeBytes == stat.Size() && wm.MtimeMs == stat.ModTime().UnixMilli() {
		return 0, 0, 0 // File hasn't changed.
	}
	lastLine := 0
	if wm != nil {
		lastLine = wm.LastLine
	}

	// Read the file.
	f, err := os.Open(sourceFile)
	if err != nil {
		return 0, 0, 0
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 1024*1024), 4*1024*1024) // 4MB max line

	lineNum := 0
	var lines []string
	for scanner.Scan() {
		lineNum++
		if lineNum <= lastLine {
			continue // Skip already-indexed lines.
		}
		lines = append(lines, scanner.Text())
	}

	if len(lines) == 0 {
		return 0, 0, 0
	}

	now := time.Now().UnixMilli()

	// Use a transaction for atomicity.
	tx, err := db.Begin()
	if err != nil {
		return 0, 0, 0
	}
	defer tx.Rollback()

	insertMsg, err := tx.Prepare(`
		INSERT OR IGNORE INTO chat_messages (
			stable_key, session_id, session_key, agent_id, channel,
			message_id, parent_id, role, timestamp_ms, timestamp_iso,
			date_key, text, raw_json, source_file, source_line, indexed_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return 0, 0, 0
	}
	defer insertMsg.Close()

	insertFts, err := tx.Prepare(`
		INSERT OR IGNORE INTO chat_messages_fts (rowid, text, role, session_id, timestamp_iso)
		SELECT id, text, role, session_id, timestamp_iso FROM chat_messages WHERE id = ?
	`)
	if err != nil {
		// FTS may not be available; continue without it.
		insertFts = nil
	}
	defer func() {
		if insertFts != nil {
			insertFts.Close()
		}
	}()

	for i, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}

		var record JsonlRecord
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			errors++
			continue
		}

		// Only index message records.
		if record.Type != "message" || record.Message == nil {
			continue
		}

		msg := record.Message
		if msg.Role == "" {
			errors++
			continue
		}

		text := extractText(msg.Content)
		if text == "" {
			skipped++
			continue
		}

		stableKey := buildStableKey(record, sourceFile, lastLine+i+1, line)
		timestampMs := msg.Timestamp
		if timestampMs == 0 {
			timestampMs = record.Timestamp
		}
		if timestampMs == 0 {
			timestampMs = now
		}
		timestampIso := time.UnixMilli(timestampMs).UTC().Format(time.RFC3339)
		dateKey := timestampIso[:10]

		channel := extractChannelFromSessionKey(sessionKey)
		messageID := msg.ID
		parentID := msg.ParentID
		sessionID := extractSessionID(record, sourceFile)

		result, err := insertMsg.Exec(
			stableKey, sessionID, sessionKey, agentID, channel,
			messageID, parentID, msg.Role, timestampMs, timestampIso,
			dateKey, text, line, sourceFile, lastLine+i+1, now,
		)
		if err != nil {
			errors++
			continue
		}

		// Check if the row was actually inserted (not ignored due to duplicate).
		rowsAffected, _ := result.RowsAffected()
		if rowsAffected > 0 {
			indexed++
			// Insert into FTS if available.
			if insertFts != nil {
				lastID, _ := result.LastInsertId()
				if lastID > 0 {
					insertFts.Exec(lastID)
				}
			}
		} else {
			skipped++
		}
	}

	// Update watermark.
	updateWatermark(tx, sourceFile, stat.Size(), stat.ModTime().UnixMilli(), lastLine+len(lines), now)

	if err := tx.Commit(); err != nil {
		return 0, 0, 0
	}

	return indexed, skipped, errors
}

func getWatermark(db *sql.DB, sourceFile string) *WatermarkRow {
	var wm WatermarkRow
	err := db.QueryRow(
		`SELECT source_file, size_bytes, mtime_ms, last_line, last_indexed_at_ms FROM chat_index_watermarks WHERE source_file = ?`,
		sourceFile,
	).Scan(&wm.SourceFile, &wm.SizeBytes, &wm.MtimeMs, &wm.LastLine, &wm.LastIndexedAtMs)
	if err != nil {
		return nil
	}
	return &wm
}

func updateWatermark(tx *sql.Tx, sourceFile string, sizeBytes, mtimeMs int64, lastLine int, nowMs int64) {
	tx.Exec(`INSERT OR REPLACE INTO chat_index_watermarks (source_file, size_bytes, mtime_ms, last_line, last_indexed_at_ms) VALUES (?, ?, ?, ?, ?)`,
		sourceFile, sizeBytes, mtimeMs, lastLine, nowMs)
}

func buildStableKey(record JsonlRecord, sourceFile string, sourceLine int, rawJson string) string {
	if record.ID != "" {
		return "msg:" + record.ID
	}
	if record.Message != nil && record.Message.ID != "" {
		return "msg:" + record.Message.ID
	}
	// Fallback: source_file + source_line + hash.
	hash := sha256.Sum256([]byte(rawJson))
	return fmt.Sprintf("line:%s:%d:%x", sourceFile, sourceLine, hash[:8])
}

func extractText(content interface{}) string {
	if content == nil {
		return ""
	}
	if s, ok := content.(string); ok {
		return strings.TrimSpace(s)
	}
	blocks, ok := content.([]interface{})
	if !ok {
		return ""
	}
	var parts []string
	for _, block := range blocks {
		m, ok := block.(map[string]interface{})
		if !ok {
			continue
		}
		t, _ := m["type"].(string)
		if t != "text" {
			continue
		}
		text, _ := m["text"].(string)
		if text == "" {
			continue
		}
		// Skip large base64 payloads.
		if len(text) > 10000 && strings.HasPrefix(text, "data:") {
			parts = append(parts, "[media]")
			continue
		}
		normalized := strings.TrimSpace(text)
		if normalized != "" {
			parts = append(parts, normalized)
		}
	}
	return strings.Join(parts, " ")
}

func extractSessionID(record JsonlRecord, sourceFile string) string {
	if record.ID != "" {
		return record.ID
	}
	// Try to extract from file path (e.g., .../sessions/abc123.jsonl).
	base := strings.TrimSuffix(sourceFile, ".jsonl")
	idx := strings.LastIndex(base, "/")
	if idx < 0 {
		idx = strings.LastIndex(base, "\\")
	}
	if idx >= 0 {
		return base[idx+1:]
	}
	return "unknown"
}

func extractChannelFromSessionKey(sessionKey string) string {
	if sessionKey == "" {
		return ""
	}
	parts := strings.Split(sessionKey, ":")
	if len(parts) >= 3 {
		return parts[2]
	}
	return ""
}
