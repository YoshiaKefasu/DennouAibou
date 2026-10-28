// Command kaden is the DennouAibou 電脳架電 (Dennou Kaden) voice-call daemon.
//
// It speaks the host binary-plugin protocol defined in
// `src/plugins/binary-runner.ts`: newline-delimited JSON-RPC 2.0 over
// stdin/stdout. stdout is the RPC channel only, so every diagnostic goes to
// stderr.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
)

const (
	// protocolVersion must stay in sync with BINARY_PLUGIN_PROTOCOL_VERSION in
	// src/plugins/binary-runner.ts.
	protocolVersion = 1
	// pluginID is the manifest id this binary is shipped for.
	pluginID = "dennou-kaden"
	// maxRequestBytes bounds one request line so a runaway host cannot exhaust
	// memory. The host forwards tool arguments, so leave generous headroom.
	maxRequestBytes = 8 << 20
	// defaultCallQueueDepth documents that this daemon dispatches calls inline.
	defaultCallQueueDepth = 0
)

// JSON-RPC 2.0 error codes used by this daemon.
const (
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
)

// supportedActions lists the `kaden_call` actions in user-facing order.
var supportedActions = []string{"status", "ping"}

// capabilities is advertised on `initialize`.
//
// TODO(dennou-kaden): add "voice" here once the audio send/receive and
// STT/TTS streaming pipeline is actually implemented. Advertising it earlier
// would make the host assume capabilities this daemon does not serve yet.
var capabilities = []string{"tools"}

// request is one host -> binary JSON-RPC 2.0 request.
type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// rpcError is the JSON-RPC 2.0 error object.
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// response is one binary -> host JSON-RPC 2.0 response.
type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// toolContent mirrors the host AgentToolResult content blocks.
type toolContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// toolResult mirrors the host AgentToolResult shape the bridge expects.
type toolResult struct {
	Content []toolContent  `json:"content"`
	Details map[string]any `json:"details"`
}

// initializeParams is the host handshake payload.
type initializeParams struct {
	ProtocolVersion int            `json:"protocolVersion"`
	PluginID        string         `json:"pluginId"`
	Tools           []string       `json:"tools"`
	Config          map[string]any `json:"config"`
}

// initializeResult is the handshake reply.
type initializeResult struct {
	ProtocolVersion int      `json:"protocolVersion"`
	Status          string   `json:"status"`
	Capabilities    []string `json:"capabilities"`
}

// toolExecuteParams accepts both the host wire shape (`tool`/`arguments`) and
// the documented shape (`toolName`/`params`).
type toolExecuteParams struct {
	ToolCallID string          `json:"toolCallId"`
	Tool       string          `json:"tool"`
	ToolName   string          `json:"toolName"`
	Arguments  json.RawMessage `json:"arguments"`
	Params     json.RawMessage `json:"params"`
}

// server holds the daemon state shared by every handler.
type server struct {
	pluginID   string
	config     map[string]any
	tools      []string
	startedAt  time.Time
	calls      int
	lastTool   string
	lastAction string
	ready      bool
}

func newServer() *server {
	return &server{
		pluginID:  pluginID,
		config:    map[string]any{},
		tools:     []string{},
		startedAt: time.Now(),
	}
}

func main() {
	srv := newServer()
	srv.installSignalHandler()
	if err := srv.serve(os.Stdin, os.Stdout); err != nil {
		srv.logf("%v", err)
		os.Exit(1)
	}
}

// installSignalHandler exits cleanly on SIGINT/SIGTERM so the host never sees a
// crashed child process. Normal termination stays silent: the host promotes any
// stderr line to a warn log, and a clean shutdown is not a warning.
func (s *server) installSignalHandler() {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signals
		os.Exit(0)
	}()
}

// serve reads newline-delimited JSON-RPC requests until stdin closes or the host
// asks for shutdown.
func (s *server) serve(stdin io.Reader, stdout io.Writer) error {
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)

	scanner := bufio.NewScanner(stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), maxRequestBytes)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		stop, err := s.handleLine(line, encoder)
		if err != nil {
			return err
		}
		if stop {
			return nil
		}
	}
	return scanner.Err()
}

// handleLine decodes one request line, dispatches it, and writes the response.
// It reports whether the daemon should stop.
func (s *server) handleLine(line string, encoder *json.Encoder) (bool, error) {
	var req request
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		// Nothing to correlate a reply to, so keep stdout clean.
		s.logf("dropping malformed request line: %v", err)
		return false, nil
	}
	if strings.TrimSpace(req.Method) == "" {
		s.logf("dropping request without method")
		return false, nil
	}

	result, rpcErr, stop := s.dispatch(req)
	if isNotification(req.ID) {
		return stop, nil
	}

	resp := &response{JSONRPC: "2.0", ID: req.ID}
	if rpcErr != nil {
		resp.Error = rpcErr
	} else {
		resp.Result = result
	}
	if err := encoder.Encode(resp); err != nil {
		return true, fmt.Errorf("failed to write response: %w", err)
	}
	return stop, nil
}

// dispatch routes one request to its handler.
func (s *server) dispatch(req request) (any, *rpcError, bool) {
	switch req.Method {
	case "initialize":
		return s.handleInitialize(req.Params)
	case "tool.execute":
		return s.handleToolExecute(req.Params)
	case "shutdown":
		// Normal exit path: keep stderr silent so the host does not log a warning.
		return map[string]any{"ok": true}, nil, true
	case "ping":
		return map[string]any{"pong": true}, nil, false
	default:
		return nil, &rpcError{
			Code:    codeMethodNotFound,
			Message: fmt.Sprintf("unsupported method %q", req.Method),
		}, false
	}
}

func (s *server) handleInitialize(raw json.RawMessage) (any, *rpcError, bool) {
	params := initializeParams{}
	if err := decodeOptional(raw, &params); err != nil {
		return nil, invalidParams(err), false
	}
	if params.PluginID != "" {
		s.pluginID = params.PluginID
	}
	if params.Config != nil {
		s.config = params.Config
	}
	if params.Tools != nil {
		s.tools = params.Tools
	}
	s.ready = true
	return initializeResult{
		ProtocolVersion: protocolVersion,
		Status:          "ready",
		Capabilities:    capabilities,
	}, nil, false
}

func (s *server) handleToolExecute(raw json.RawMessage) (any, *rpcError, bool) {
	params := toolExecuteParams{}
	if err := decodeOptional(raw, &params); err != nil {
		return nil, invalidParams(err), false
	}
	toolName := firstNonEmpty(params.Tool, params.ToolName)
	if toolName == "" {
		return nil, invalidParams(errors.New("tool.execute requires a tool name")), false
	}
	args := params.Arguments
	if isEmptyJSON(args) {
		args = params.Params
	}
	arguments := map[string]any{}
	if err := decodeOptional(args, &arguments); err != nil {
		return nil, invalidParams(err), false
	}
	if arguments == nil {
		arguments = map[string]any{}
	}

	s.calls++
	s.lastTool = toolName

	switch toolName {
	case "kaden_status":
		return s.statusResult(), nil, false
	case "kaden_call":
		return s.callResult(arguments), nil, false
	default:
		return nil, &rpcError{
			Code:    codeMethodNotFound,
			Message: fmt.Sprintf("unsupported tool %q", toolName),
		}, false
	}
}

// statusResult reports daemon health plus Go runtime facts.
func (s *server) statusResult() toolResult {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	lines := []string{
		fmt.Sprintf("%s: %s", s.pluginID, s.state()),
		fmt.Sprintf("go: %s", runtime.Version()),
		fmt.Sprintf("platform: %s/%s", runtime.GOOS, runtime.GOARCH),
		fmt.Sprintf("goroutines: %d", runtime.NumGoroutine()),
		fmt.Sprintf(
			"memory: %.2f MiB heap / %.2f MiB sys / %d GC cycles",
			bytesToMiB(mem.HeapAlloc),
			bytesToMiB(mem.Sys),
			mem.NumGC,
		),
		fmt.Sprintf("uptime: %s", time.Since(s.startedAt).Round(time.Millisecond)),
		fmt.Sprintf("protocol: %d", protocolVersion),
		fmt.Sprintf("tools: %s", strings.Join(s.advertisedTools(), ", ")),
		fmt.Sprintf("calls: %d", s.calls),
		fmt.Sprintf("last tool: %s", orNone(s.lastTool)),
		fmt.Sprintf("last action: %s", orNone(s.lastAction)),
		fmt.Sprintf("config: enabled=%t port=%d", s.enabled(), s.port()),
	}
	details := map[string]any{
		"pluginId":     s.pluginID,
		"state":        s.state(),
		"goVersion":    runtime.Version(),
		"goos":         runtime.GOOS,
		"goarch":       runtime.GOARCH,
		"goroutines":   runtime.NumGoroutine(),
		"heapAllocMiB": round2(bytesToMiB(mem.HeapAlloc)),
		"sysMiB":       round2(bytesToMiB(mem.Sys)),
		"gcCycles":     mem.NumGC,
		"uptimeMs":     time.Since(s.startedAt).Milliseconds(),
		"protocol":     protocolVersion,
		"tools":        s.advertisedTools(),
		"calls":        s.calls,
		"lastTool":     s.lastTool,
		"lastAction":   s.lastAction,
		"enabled":      s.enabled(),
		"port":         s.port(),
		"queueDepth":   defaultCallQueueDepth,
		"capabilities": capabilities,
	}
	return textResult(strings.Join(lines, "\n"), details)
}

// callResult handles the `kaden_call` actions. Unknown actions return a
// user-facing message instead of a JSON-RPC error so the agent can recover.
func (s *server) callResult(arguments map[string]any) toolResult {
	started := time.Now()
	action := strings.ToLower(strings.TrimSpace(asString(arguments["action"])))
	s.lastAction = action

	switch action {
	case "status":
		lines := []string{
			fmt.Sprintf("%s call session: idle", s.pluginID),
			fmt.Sprintf("queue depth: %d", defaultCallQueueDepth),
			fmt.Sprintf("daemon state: %s", s.state()),
			fmt.Sprintf("calls served: %d", s.calls),
			fmt.Sprintf("port: %d", s.port()),
		}
		return textResult(strings.Join(lines, "\n"), map[string]any{
			"action":     "status",
			"ok":         true,
			"state":      "idle",
			"queueDepth": defaultCallQueueDepth,
			"calls":      s.calls,
			"port":       s.port(),
		})
	case "ping":
		latency := time.Since(started)
		return textResult(fmt.Sprintf("pong (%s)", latency), map[string]any{
			"action":    "ping",
			"ok":        true,
			"pong":      true,
			"latencyMs": float64(latency.Microseconds()) / 1000.0,
			"daemon":    s.state(),
		})
	case "":
		return textResult(
			fmt.Sprintf("kaden_call requires an action (%s)", strings.Join(supportedActions, ", ")),
			map[string]any{"action": "", "ok": false, "validActions": supportedActions},
		)
	default:
		return textResult(
			fmt.Sprintf("unsupported action %q (valid: %s)", action, strings.Join(supportedActions, ", ")),
			map[string]any{
				"action":       action,
				"ok":           false,
				"validActions": supportedActions,
			},
		)
	}
}

func (s *server) state() string {
	if !s.ready {
		return "starting"
	}
	if !s.enabled() {
		return "disabled (config enabled=false)"
	}
	return "ready (awaiting calls)"
}

func (s *server) advertisedTools() []string {
	tools := append([]string{}, s.tools...)
	if len(tools) == 0 {
		tools = []string{"kaden_status", "kaden_call"}
	}
	sort.Strings(tools)
	return tools
}

// enabled honours the manifest `enabled` config flag (defaults to true).
func (s *server) enabled() bool {
	raw, ok := s.config["enabled"]
	if !ok {
		return true
	}
	value, isBool := raw.(bool)
	if !isBool {
		return true
	}
	return value
}

// port honours the manifest `port` config value, reporting 0 when unset.
func (s *server) port() int {
	raw, ok := s.config["port"]
	if !ok {
		return 0
	}
	switch value := raw.(type) {
	case float64:
		return int(value)
	case int:
		return value
	case json.Number:
		parsed, err := value.Int64()
		if err != nil {
			return 0
		}
		return int(parsed)
	default:
		return 0
	}
}

func (s *server) logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "dennou-kaden: "+format+"\n", args...)
}

func textResult(text string, details map[string]any) toolResult {
	if details == nil {
		details = map[string]any{}
	}
	return toolResult{
		Content: []toolContent{{Type: "text", Text: text}},
		Details: details,
	}
}

func invalidParams(err error) *rpcError {
	return &rpcError{Code: codeInvalidParams, Message: err.Error()}
}

func decodeOptional(raw json.RawMessage, target any) error {
	if isEmptyJSON(raw) {
		return nil
	}
	return json.Unmarshal(raw, target)
}

func isEmptyJSON(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return trimmed == "" || trimmed == "null"
}

func isNotification(id json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(id))
	return trimmed == "" || trimmed == "null"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func asString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func orNone(value string) string {
	if strings.TrimSpace(value) == "" {
		return "(none)"
	}
	return value
}

func bytesToMiB(bytes uint64) float64 {
	return float64(bytes) / (1024 * 1024)
}

func round2(value float64) float64 {
	return float64(int64(value*100+0.5)) / 100
}
