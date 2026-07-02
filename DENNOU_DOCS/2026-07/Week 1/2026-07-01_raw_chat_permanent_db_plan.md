# Raw Chat Permanent DB Plan

Date: 2026-07-01
Status: Draft plan

## 1. Goal

Create a permanent raw chat search layer for DennouAibou.

The goal is not to create another narrative memory system. The goal is to keep an exact searchable ledger of session JSONL messages, so the agent can search old chat history by keyword, date, time range, session, channel, and message context.

## 2. Background

DennouAibou already stores conversations as session JSONL. That JSONL remains the source of truth.

The new system should index from existing session JSONL directly into a permanent database. It should not create a second daily raw JSONL archive, because that would duplicate storage and introduce another sync problem.

The user-facing need is simple:

- Search old chat text by keyword.
- Narrow results by date and exact time range.
- Jump to the surrounding conversation around a result.
- Let the agent use this through one compact tool, not a large tool cluster.

## 3. Non-goals

This plan explicitly avoids these paths:

- Do not put this inside Episodic-Claw narrative memory.
- Do not add five separate chat tools.
- Do not create another daily raw JSONL archive.
- Do not replace the existing session JSONL writer.
- Do not force semantic/vector search in Phase 1.
- Do not merge raw chat ledger semantics into `memory_search` without a separate schema boundary.

## 4. Evidence from current code

### 4.1 DennouAibou owns the session transcript source

- `src/config/sessions/transcript.ts:38-80` resolves the active session transcript file from `sessionId`, `sessionKey`, agent id, and session store data.
- `src/config/sessions/transcript.ts:83-168` constructs and appends assistant messages; `src/config/sessions/transcript.ts:168` emits `emitSessionTranscriptUpdate()`.

Meaning: DennouAibou is closest to the raw chat source. Indexing should start from the session JSONL pipeline, not from a secondary exported archive.

### 4.2 Existing Memory is file/chunk-oriented, not raw-message-oriented

- `extensions/memory-core/src/tools.ts:71-136` defines `memory_search` as semantic search over `MEMORY.md`, `memory/*.md`, and optional session transcript snippets.
- `extensions/memory-core/src/prompt-section.ts:14-36` tells the model to use `memory_search` for prior work, decisions, preferences, and todos.
- `src/memory-host-sdk/host/memory-schema.ts:18-39` stores indexed content as `files` and `chunks`.
- `src/memory-host-sdk/host/session-files.ts:75-127` converts session JSONL into flattened `User:` / `Assistant:` text lines for memory indexing.

Meaning: current Memory is good for durable notes and chunked recall. It is not a precise raw-message ledger with `messageId`, `parentId`, `timestamp`, `sourceLine`, and `raw_json` preserved per row.

### 4.3 Existing SQLite pieces can be reused without reusing Memory semantics

- `src/memory-host-sdk/host/sqlite.ts:6-17` already wraps `node:sqlite` availability checks.
- `src/memory-host-sdk/host/memory-schema.ts:60-80` already uses SQLite FTS5.
- `src/memory-host-sdk/host/sqlite-vec.ts:3-23` treats `sqlite-vec` as a SQLite extension, not a separate database.

Meaning: reuse the proven storage patterns, but keep a separate raw chat schema and API.

## 5. Database decision

Use **SQLite + FTS5** for Phase 1.

`sqlite-vec` is not a separate database. It is a SQLite extension. If semantic search becomes necessary later, it can be added to the same SQLite database as an optional vector table.

### 5.1 Selected stack

```text
raw-chat.sqlite
  chat_messages          -- exact raw message ledger
  chat_messages_fts      -- FTS5 keyword search
  chat_index_watermarks  -- per session file indexing progress
  chat_message_vectors   -- optional Phase 6 sqlite-vec table
```

### 5.2 Why SQLite first

SQLite is the best fit for the required access patterns:

- exact timestamp range queries
- date filtering
- message id lookups
- session and channel filtering
- keyword search via FTS5
- transactional incremental indexing
- one local database file

This is a ledger problem first, not a vector search problem first.

### 5.3 Why not LanceDB for Phase 1

LanceDB is useful for vector and hybrid retrieval, but raw chat search needs exact filters first. Starting with LanceDB would add a second storage model and more packaging/runtime complexity without solving the core date/time ledger requirement better than SQLite.

Decision: **do not adopt LanceDB for the raw chat permanent DB.**

### 5.4 sqlite-vec position

`sqlite-vec` remains a Phase 6 option in the same SQLite file.

Do not add it in Phase 1 unless semantic search is explicitly required. This avoids migration and build complexity while keeping the future path open.

## 6. Proposed schema

### 6.1 `chat_messages`

```sql
CREATE TABLE chat_messages (
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
);
```

`stable_key` should be deterministic. Preferred order:

1. `message_id` when present and stable.
2. Otherwise `source_file + source_line + hash(raw_json)`.

`date_key` must use ISO 8601 calendar date format: `YYYY-MM-DD`.

### 6.2 Indexes

```sql
CREATE INDEX idx_chat_messages_timestamp ON chat_messages(timestamp_ms);
CREATE INDEX idx_chat_messages_date ON chat_messages(date_key);
CREATE INDEX idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX idx_chat_messages_agent_channel ON chat_messages(agent_id, channel);
CREATE INDEX idx_chat_messages_message_id ON chat_messages(message_id);
CREATE INDEX idx_chat_messages_role ON chat_messages(role);
```

### 6.3 FTS table

```sql
CREATE VIRTUAL TABLE chat_messages_fts USING fts5(
  text,
  role UNINDEXED,
  session_id UNINDEXED,
  timestamp_iso UNINDEXED,
  content='chat_messages',
  content_rowid='id',
  tokenize='unicode61'
);
```

Use triggers or explicit insert/update code to keep FTS synchronized. Explicit code is simpler for Phase 1 because indexing is append-oriented.

Use `unicode61` in Phase 1 to match the existing Memory FTS default pattern. Japanese/CJK keyword quality may be limited; if this becomes a real issue, evaluate `trigram` tokenizer or semantic search in Phase 6.

### 6.4 Watermarks

```sql
CREATE TABLE chat_index_watermarks (
  source_file TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  last_line INTEGER NOT NULL,
  last_indexed_at_ms INTEGER NOT NULL
);
```

Watermarks allow incremental indexing from session JSONL without rescanning the full file every time.

## 7. Indexing flow

### 7.1 Source of truth

The session JSONL file remains the source of truth. The database is a searchable index, not the canonical transcript writer.

### 7.2 Incremental path

1. DennouAibou writes or updates the session JSONL as it already does today.
2. The raw chat indexer receives a transcript update event or runs a short debounce scan.
3. The indexer looks up `chat_index_watermarks` for the session file.
4. It reads only lines after `last_line` when safe.
5. It parses valid JSONL message records.
6. It inserts rows with `INSERT OR IGNORE` using `stable_key`.
7. It updates the FTS table.
8. It updates the watermark after a successful transaction.

### 7.3 Repair and rebuild path

If the DB is missing, corrupted, or schema migration fails, rebuild from session JSONL files.

This is possible because the DB is derived from the JSONL source of truth.

### 7.4 Go implementation

The low-latency index/search engine must be implemented in Go.

Go is required here because raw chat indexing/search can grow with every message. Keeping SQLite indexing, FTS search, ranking, and context expansion outside the Node gateway avoids putting long-running DB work and memory pressure on the interactive gateway process.

Recommended shape:

```text
DennouAibou TypeScript
  session event / tool registration / config
  ↓ narrow RPC
Go raw chat engine
  SQLite open/migrate
  JSONL tail indexing
  FTS search
  date/time filtering
  context-window expansion
```

Keep the TypeScript side thin. Heavy parsing, indexing, ranking, and DB work must live in Go.

There is no existing root Go module for this subsystem in DennouAibou. The raw chat engine should therefore define its own small Go module and choose a SQLite driver deliberately.

Phase 1 needs FTS5 support. Phase 6 sqlite-vec support would add either a CGO binding or a WASM-backed SQLite driver. Do not add sqlite-vec until semantic search is required.

### 7.5 Sidecar lifecycle

Follow the existing Episodic-Claw sidecar pattern instead of inventing a new ad-hoc process model.

Evidence: `episodic-claw/src/rpc-client.ts:17-18` shares a dynamic socket address through `episodic-claw-socket.addr`, and `episodic-claw/src/rpc-client.ts:45-55` manages a typed client with a socket and pending JSON-RPC requests.

Recommended shape:

- TypeScript starts the Go process.
- Go opens a local TCP or Unix socket.
- The socket address is shared through a temp file.
- TypeScript uses newline-delimited JSON-RPC or an equivalent narrow RPC protocol.
- Startup, reconnect, and shutdown should follow the same operational style as the existing sidecar code.

### 7.6 TypeScript boundary

TypeScript is allowed to own only the gateway-facing boundary:

- Go sidecar launch and shutdown.
- transcript update hook and debounce.
- typed RPC request/response validation.
- `chat_search` tool registration and compact result formatting.
- config flag and kill switch wiring.

TypeScript must not own the permanent DB implementation:

- no TypeScript SQLite schema/migration body
- no TypeScript JSONL tail indexer as the production path
- no TypeScript FTS search engine as the production path
- no TypeScript context-window expansion as the production path

Any existing TypeScript prototype for these areas is only a reference for schema shape, tool shape, and test cases. It must not be treated as the accepted Phase 1 implementation.

### 7.6.1 Existing TypeScript implementation disposition

The current TypeScript prototype under `src/dennou-soul/raw-chat/` is not the production design.

Known prototype files include:

- `src/dennou-soul/raw-chat/schema.ts`
- `src/dennou-soul/raw-chat/db.ts`
- `src/dennou-soul/raw-chat/indexer.ts`
- `src/dennou-soul/raw-chat/search.ts`
- `src/dennou-soul/raw-chat/tool.ts`
- `src/dennou-soul/raw-chat/hook.ts`
- `src/dennou-soul/raw-chat/resolve-agent.ts`
- `src/dennou-soul/raw-chat/raw-chat.test.ts`

Before Phase 1 can ship, these files must be removed, converted to test-only reference fixtures, or reduced to TypeScript RPC/tool boundary wrappers. Production gateway startup must not import a TypeScript DB/index/search path.

In particular, `src/gateway/server.impl.ts` must not import a TypeScript raw chat hook that owns SQLite schema, indexing, or search. It may only start the Go sidecar boundary after the Go implementation exists.

Any file deletion or conversion must be done only after explicit operator approval, because the current repository already contains a working prototype that may be useful as reference.

### 7.6.2 Enforcement

Add an enforcement check before this feature ships:

- Add a `DENNOU_RULES.md` entry or equivalent review checklist requiring reviewers to verify that raw chat DB/index/search production logic is Go-owned.
- Add a CI or targeted grep check that flags `node:sqlite` usage inside `src/dennou-soul/raw-chat/` production files.
- Keep TypeScript tests focused on RPC/tool boundary behavior. Do not add TypeScript tests that validate production SQLite indexing/search behavior.

## 8. Tool design

Use **one tool** in Phase 1:

```text
chat_search
```

Do not add `chat_day`, `chat_around`, `chat_expand`, or `chat_get` as separate tools in Phase 1. Those modes can be represented as parameters of one tool.

### 8.1 Parameters

```json
{
  "query": "EJU",
  "from": "2026-06-29T18:00:00+07:00",
  "to": "2026-06-29T20:00:00+07:00",
  "date": "2026-06-29",
  "messageId": "optional-message-id",
  "role": "user",
  "agentId": "main",
  "channel": "telegram",
  "limit": 20,
  "contextBefore": 3,
  "contextAfter": 3
}
```

### 8.2 Modes through one tool

- `query` only: keyword search.
- `date` only: list relevant messages for that date.
- `from` + `to`: exact time range search.
- `messageId` + context values: show surrounding conversation.
- `query` + `from` + `to`: keyword search inside a time window.

### 8.3 Return shape

Return compact records by default:

```json
{
  "results": [
    {
      "messageId": "...",
      "timestamp": "2026-06-29T18:30:12+07:00",
      "role": "user",
      "sessionKey": "agent:main:telegram:dm:...",
      "channel": "telegram",
      "snippet": "...",
      "context": ["...optional surrounding messages..."]
    }
  ]
}
```

Keep raw JSON out of default output. Return raw JSON only behind an explicit debug parameter if needed later.

## 9. Boundary with existing Memory

Do not replace or heavily modify `memory_search`.

Recommended split:

| System | Responsibility |
|---|---|
| `memory_search` | durable notes, decisions, preferences, summaries, `MEMORY.md`, `memory/*.md`, optional chunked session recall |
| `chat_search` | exact raw chat ledger search by keyword/date/time/message context |

This avoids mixing two very different meanings of “memory”.

### 9.1 What to reuse

Reuse existing patterns where they are technical infrastructure:

- SQLite availability checks.
- FTS5 schema patterns.
- tool registration style.
- session transcript file resolution.
- config schema/help style.

### 9.2 What not to reuse

Do not reuse these as the raw chat storage model:

- `files` / `chunks` tables from Memory.
- `memory_search` result shape.
- `memory_get` line-based file reader semantics.
- `memory-lancedb` plugin storage.

Those are optimized for memory notes and chunked retrieval, not raw message ledgers.

## 10. Migration strategy

Keep migrations boring.

Use a simple `schema_version` entry in a `meta` table:

```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

For Phase 1, prefer additive migrations only:

- create missing tables
- create missing indexes
- add nullable columns when needed
- never rewrite old chat rows unless a rebuild is explicitly requested

If a migration becomes risky, rebuild the DB from session JSONL instead of mutating production rows in place.

## 11. Safety rules

1. Session JSONL remains canonical.
2. The DB may be deleted and rebuilt.
3. Indexing must be idempotent.
4. Insert paths must use deterministic uniqueness.
5. Search must not expose secrets beyond what already exists in the local transcript.
6. Default tool output must return snippets, not full raw JSON.
7. Large media/base64 payloads should store metadata or redacted placeholders in searchable text. Media URLs and attachment metadata may be indexed as metadata fields, but large raw binary/base64 content should not be copied into FTS text.
8. A kill switch must disable indexing without affecting normal chat.
9. DB write failures must not block message delivery.

## 12. Implementation phases

### Phase 1: Planning and schema proof

- Finalize schema.
- Use the recommended per-agent DB path unless implementation review finds a strong reason to change it.
- Write schema creation tests.
- Write JSONL parsing tests with real-ish message records.

### Phase 2: Go raw chat engine

- Create a small raw-chat Go module or sidecar package for this subsystem.
- Add SQLite open/migrate code.
- Add session JSONL tail indexer.
- Add FTS insert/update path.
- Add keyword and time-range query API.
- Add context-window expansion API.
- Add Go unit tests for schema, idempotency, incremental indexing, FTS search, and context expansion.
- After the Go sidecar passes targeted tests, remove or convert the TypeScript prototype DB/index/search modules so there is only one production path.
- **Security: sanitize AgentID in handleBackfill to reject values containing `/` or `..` to prevent filesystem path injection.**

### Phase 3: DennouAibou integration

- Add TypeScript wrapper/RPC boundary.
- Hook transcript update events with debounce.
- Add config flag and kill switch.
- Ensure indexing failure logs are small and non-blocking.
- Do not duplicate the Go DB/index/search logic in TypeScript.
- **Note: the initial kill switch (`dennou.rawChat.indexing.enabled`) is evaluated at startup. Changing it at runtime requires a gateway restart. Document this in help text and config schema.**

### Phase 4: Agent tool

- Add one tool: `chat_search`.
- Support keyword, date, time range, and messageId context modes.
- Add compact result formatting.
- Add tool policy/catalog entries.

### Phase 5: Backfill and verification

- Backfill existing KASOU session JSONL into the DB.
- Verify row counts against JSONL message counts.
- Verify time range search.
- Verify keyword search.
- Verify context expansion.

### Phase 6: Optional semantic search

- Add sqlite-vec only if exact/FTS search is not enough.
- Keep it in the same SQLite DB.
- Do not move to LanceDB unless there is a separate, proven semantic-search requirement.

## 13. Test plan

Minimum targeted tests:

- Schema creation is idempotent.
- Indexing the same JSONL twice does not duplicate rows.
- Malformed JSONL lines are skipped and reported without stopping indexing.
- Text extraction ignores large binary/base64 payloads by default.
- Date-only search returns messages for that date.
- `from` / `to` search returns only messages in range.
- Keyword FTS search returns expected snippets.
- `messageId` context search returns before/after messages.
- DB can be rebuilt from JSONL after deletion.
- Kill switch disables indexing but does not affect chat delivery.
- TypeScript RPC wrapper handles Go sidecar unavailable/error responses without blocking chat delivery.
- TypeScript tool tests should mock the RPC boundary instead of reimplementing search behavior.
- Add an enforcement test or CI check that fails if production TypeScript raw-chat code owns SQLite schema, indexing, or FTS search.

## 14. Implementation decisions

1. DB path:
   - Recommended: `~/.openclaw/agents/<agentId>/raw-chat.sqlite`
   - Rationale: raw chat search should preserve agent isolation and follow the existing per-agent session layout.
   - Alternative: `~/.openclaw/raw-chat/raw-chat.sqlite` is simpler for global search, but it should not be the Phase 1 default.

2. Tool name:
   - `chat_search` is clear and compact.
   - Avoid `memory_search` changes to prevent semantic confusion.

3. Go SQLite driver:
   - Phase 1 can use a standard Go SQLite driver with FTS5 support.
   - sqlite-vec requires either CGO binding or a WASM-backed SQLite driver later.

4. Privacy and retention:
   - This is permanent by design.
   - Add explicit config to disable indexing or exclude specific channels if needed.

## 15. Recommendation

Build this as a DennouAibou raw chat subsystem, not as Episodic-Claw and not as a direct mutation of `memory_search`.

Use SQLite + FTS5 first. Keep `sqlite-vec` as a same-DB Phase 6 extension. Do not adopt LanceDB for Phase 1.

Expose one agent tool: `chat_search`.
