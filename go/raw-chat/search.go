package main

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// Search searches the raw chat DB with keyword, date, time range, and context modes.
func Search(db *sql.DB, params SearchParams) SearchResults {
	limit := params.Limit
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	contextBefore := params.ContextBefore
	if contextBefore < 0 || contextBefore > 10 {
		contextBefore = 0
	}
	contextAfter := params.ContextAfter
	if contextAfter < 0 || contextAfter > 10 {
		contextAfter = 0
	}

	// Mode: messageId context search.
	if params.MessageID != "" {
		return searchByMessageID(db, params.MessageID, contextBefore, contextAfter)
	}

	// Mode: FTS keyword search.
	if params.Query != "" {
		if IsFts5Available(db) {
			return searchByFts(db, params, limit)
		}
		// FTS5 not available — fall back to LIKE search on text column.
		emitLog("warning: FTS5 not available, falling back to LIKE search for keyword query")
		return searchByLike(db, params, limit)
	}

	// Mode: date/time range or filter search.
	return searchByFilters(db, params, limit)
}

func searchByFts(db *sql.DB, params SearchParams, limit int) SearchResults {
	escapedQuery := escapeFts5(params.Query)
	if escapedQuery == "" {
		return SearchResults{}
	}

	// Build the query with optional metadata filters.
	conditions := []string{`chat_messages_fts MATCH ?`}
	args := []interface{}{escapedQuery}

	if params.Date != "" {
		conditions = append(conditions, `m.date_key = ?`)
		args = append(args, params.Date)
	}
	if params.From != "" {
		if ms := parseTimestampMs(params.From); ms > 0 {
			conditions = append(conditions, `m.timestamp_ms >= ?`)
			args = append(args, ms)
		}
	}
	if params.To != "" {
		if ms := parseTimestampMs(params.To); ms > 0 {
			conditions = append(conditions, `m.timestamp_ms <= ?`)
			args = append(args, ms)
		}
	}
	if params.Role != "" {
		conditions = append(conditions, `m.role = ?`)
		args = append(args, params.Role)
	}
	if params.AgentID != "" {
		conditions = append(conditions, `m.agent_id = ?`)
		args = append(args, params.AgentID)
	}
	if params.Channel != "" {
		conditions = append(conditions, `m.channel = ?`)
		args = append(args, params.Channel)
	}

	where := strings.Join(conditions, " AND ")
	query := fmt.Sprintf(`
		SELECT m.message_id, m.session_id, m.agent_id, m.channel, m.role, m.timestamp_iso, m.text
		FROM chat_messages m
		INNER JOIN chat_messages_fts f ON f.rowid = m.id
		WHERE %s
		ORDER BY m.timestamp_ms DESC
		LIMIT ?
	`, where)
	args = append(args, limit)

	return executeSearch(db, query, args)
}

// searchByLike performs a LIKE-based keyword search when FTS5 is unavailable.
// This is a degraded fallback — less performant and less accurate than FTS5.
func searchByLike(db *sql.DB, params SearchParams, limit int) SearchResults {
	queryText := "%" + params.Query + "%"
	conditions := []string{`text LIKE ?`}
	args := []interface{}{queryText}

	if params.Date != "" {
		conditions = append(conditions, `date_key = ?`)
		args = append(args, params.Date)
	}
	if params.From != "" {
		if ms := parseTimestampMs(params.From); ms > 0 {
			conditions = append(conditions, `timestamp_ms >= ?`)
			args = append(args, ms)
		}
	}
	if params.To != "" {
		if ms := parseTimestampMs(params.To); ms > 0 {
			conditions = append(conditions, `timestamp_ms <= ?`)
			args = append(args, ms)
		}
	}
	if params.Role != "" {
		conditions = append(conditions, `role = ?`)
		args = append(args, params.Role)
	}
	if params.AgentID != "" {
		conditions = append(conditions, `agent_id = ?`)
		args = append(args, params.AgentID)
	}
	if params.Channel != "" {
		conditions = append(conditions, `channel = ?`)
		args = append(args, params.Channel)
	}

	where := strings.Join(conditions, " AND ")
	query := fmt.Sprintf(`
		SELECT message_id, session_id, agent_id, channel, role, timestamp_iso, text
		FROM chat_messages
		WHERE %s
		ORDER BY timestamp_ms DESC
		LIMIT ?
	`, where)
	args = append(args, limit)

	return executeSearch(db, query, args)
}

func searchByFilters(db *sql.DB, params SearchParams, limit int) SearchResults {
	conditions := []string{}
	var args []interface{}

	if params.Date != "" {
		conditions = append(conditions, `date_key = ?`)
		args = append(args, params.Date)
	}
	if params.From != "" {
		if ms := parseTimestampMs(params.From); ms > 0 {
			conditions = append(conditions, `timestamp_ms >= ?`)
			args = append(args, ms)
		}
	}
	if params.To != "" {
		if ms := parseTimestampMs(params.To); ms > 0 {
			conditions = append(conditions, `timestamp_ms <= ?`)
			args = append(args, ms)
		}
	}
	if params.Role != "" {
		conditions = append(conditions, `role = ?`)
		args = append(args, params.Role)
	}
	if params.AgentID != "" {
		conditions = append(conditions, `agent_id = ?`)
		args = append(args, params.AgentID)
	}
	if params.Channel != "" {
		conditions = append(conditions, `channel = ?`)
		args = append(args, params.Channel)
	}

	where := ""
	if len(conditions) > 0 {
		where = "WHERE " + strings.Join(conditions, " AND ")
	}

	query := fmt.Sprintf(`
		SELECT message_id, session_id, agent_id, channel, role, timestamp_iso, text
		FROM chat_messages
		%s
		ORDER BY timestamp_ms DESC
		LIMIT ?
	`, where)
	args = append(args, limit)

	return executeSearch(db, query, args)
}

func searchByMessageID(db *sql.DB, messageID string, contextBefore, contextAfter int) SearchResults {
	// Find the target message.
	var target struct {
		ID          int64
		MessageID   string
		SessionID   string
		AgentID     string
		Channel     string
		Role        string
		Timestamp   string
		Text        string
		SourceFile  string
		SourceLine  int
		TimestampMs int64
	}

	err := db.QueryRow(`
		SELECT id, message_id, session_id, agent_id, channel, role, timestamp_iso, text,
		       source_file, source_line, timestamp_ms
		FROM chat_messages
		WHERE message_id = ?
		LIMIT 1
	`, messageID).Scan(
		&target.ID, &target.MessageID, &target.SessionID, &target.AgentID, &target.Channel,
		&target.Role, &target.Timestamp, &target.Text, &target.SourceFile, &target.SourceLine, &target.TimestampMs,
	)
	if err != nil {
		return SearchResults{}
	}

	var results []SearchResult

	// Get context before.
	if contextBefore > 0 {
		rows, err := db.Query(`
			SELECT message_id, session_id, agent_id, channel, role, timestamp_iso, text
			FROM chat_messages
			WHERE source_file = ? AND source_line < ? AND timestamp_ms <= ?
			ORDER BY source_line DESC
			LIMIT ?
		`, target.SourceFile, target.SourceLine, target.TimestampMs, contextBefore)
		if err == nil {
			var before []SearchResult
			for rows.Next() {
				var r SearchResult
				rows.Scan(&r.MessageID, &r.SessionID, &r.AgentID, &r.Channel, &r.Role, &r.Timestamp, &r.Snippet)
				r.Snippet = truncateSnippet(r.Snippet, 300)
				before = append(before, r)
			}
			rows.Close()
			// Reverse to chronological order.
			for i := len(before) - 1; i >= 0; i-- {
				results = append(results, before[i])
			}
		}
	}

	// Add the target message.
	results = append(results, SearchResult{
		MessageID: target.MessageID,
		SessionID: target.SessionID,
		AgentID:   target.AgentID,
		Channel:   target.Channel,
		Role:      target.Role,
		Timestamp: target.Timestamp,
		Snippet:   truncateSnippet(target.Text, 300),
	})

	// Get context after.
	if contextAfter > 0 {
		rows, err := db.Query(`
			SELECT message_id, session_id, agent_id, channel, role, timestamp_iso, text
			FROM chat_messages
			WHERE source_file = ? AND source_line > ? AND timestamp_ms >= ?
			ORDER BY source_line ASC
			LIMIT ?
		`, target.SourceFile, target.SourceLine, target.TimestampMs, contextAfter)
		if err == nil {
			for rows.Next() {
				var r SearchResult
				rows.Scan(&r.MessageID, &r.SessionID, &r.AgentID, &r.Channel, &r.Role, &r.Timestamp, &r.Snippet)
				r.Snippet = truncateSnippet(r.Snippet, 300)
				results = append(results, r)
			}
			rows.Close()
		}
	}

	return SearchResults{Results: results, Count: len(results)}
}

func executeSearch(db *sql.DB, query string, args []interface{}) SearchResults {
	rows, err := db.Query(query, args...)
	if err != nil {
		return SearchResults{}
	}
	defer rows.Close()

	var results []SearchResult
	for rows.Next() {
		var r SearchResult
		err := rows.Scan(&r.MessageID, &r.SessionID, &r.AgentID, &r.Channel, &r.Role, &r.Timestamp, &r.Snippet)
		if err != nil {
			continue
		}
		r.Snippet = truncateSnippet(r.Snippet, 300)
		results = append(results, r)
	}

	return SearchResults{Results: results, Count: len(results)}
}

func escapeFts5(value string) string {
	// Escape FTS5 special characters.
	replacer := strings.NewReplacer(
		"'", " ",
		"\"", " ",
		"(", " ",
		")", " ",
		"*", " ",
		"^", " ",
		":", " ",
	)
	return strings.TrimSpace(replacer.Replace(value))
}

func parseTimestampMs(iso string) int64 {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		// Try ISO 8601 date-only.
		t, err = time.Parse("2006-01-02", iso)
		if err != nil {
			return 0
		}
	}
	return t.UnixMilli()
}

func truncateSnippet(text string, maxLen int) string {
	runes := []rune(text)
	if len(runes) <= maxLen {
		return text
	}
	return string(runes[:maxLen-3]) + "..."
}
