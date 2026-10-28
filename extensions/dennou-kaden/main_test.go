package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestInitializeReportsReadyProtocol(t *testing.T) {
	srv := newServer()
	result, rpcErr, stop := srv.dispatch(request{
		Method: "initialize",
		Params: json.RawMessage(`{"protocolVersion":1,"pluginId":"dennou-kaden","tools":["kaden_status","kaden_call"],"config":{"port":4321}}`),
	})
	if rpcErr != nil {
		t.Fatalf("unexpected error: %v", rpcErr)
	}
	if stop {
		t.Fatalf("initialize must not stop the daemon")
	}
	reply, ok := result.(initializeResult)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if reply.ProtocolVersion != 1 {
		t.Fatalf("protocolVersion = %d, want 1", reply.ProtocolVersion)
	}
	if reply.Status != "ready" {
		t.Fatalf("status = %q, want ready", reply.Status)
	}
	if strings.Join(reply.Capabilities, ",") != "tools" {
		t.Fatalf("capabilities = %v, want [tools] until the voice pipeline exists", reply.Capabilities)
	}
	if srv.port() != 4321 {
		t.Fatalf("port = %d, want 4321", srv.port())
	}
	if !strings.Contains(srv.state(), "ready") {
		t.Fatalf("state = %q, want ready", srv.state())
	}
}

func TestStatusToolReportsGoRuntime(t *testing.T) {
	srv := newServer()
	result, rpcErr, _ := srv.dispatch(request{
		Method: "tool.execute",
		Params: json.RawMessage(`{"toolCallId":"call-1","tool":"kaden_status","arguments":{}}`),
	})
	if rpcErr != nil {
		t.Fatalf("unexpected error: %v", rpcErr)
	}
	reply, ok := result.(toolResult)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if len(reply.Content) != 1 || reply.Content[0].Type != "text" {
		t.Fatalf("content = %+v", reply.Content)
	}
	for _, want := range []string{"dennou-kaden", "go: go", "goroutines:", "memory:", "protocol: 1"} {
		if !strings.Contains(reply.Content[0].Text, want) {
			t.Fatalf("status text missing %q:\n%s", want, reply.Content[0].Text)
		}
	}
	if reply.Details["pluginId"] != "dennou-kaden" {
		t.Fatalf("details.pluginId = %v", reply.Details["pluginId"])
	}
	if srv.calls != 1 {
		t.Fatalf("calls = %d, want 1", srv.calls)
	}
}

func TestCallToolHandlesActions(t *testing.T) {
	cases := []struct {
		name   string
		args   string
		want   string
		wantOK any
	}{
		{name: "ping", args: `{"action":"ping"}`, want: "pong", wantOK: true},
		{name: "status", args: `{"action":"status"}`, want: "call session: idle", wantOK: nil},
		{name: "uppercase action", args: `{"action":"  PING  "}`, want: "pong", wantOK: true},
		{name: "missing action", args: `{}`, want: "requires an action", wantOK: false},
		{name: "unknown action", args: `{"action":"dial"}`, want: "unsupported action", wantOK: false},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			srv := newServer()
			params := `{"toolCallId":"call-2","tool":"kaden_call","arguments":` + testCase.args + `}`
			result, rpcErr, _ := srv.dispatch(request{Method: "tool.execute", Params: json.RawMessage(params)})
			if rpcErr != nil {
				t.Fatalf("unexpected error: %v", rpcErr)
			}
			reply, ok := result.(toolResult)
			if !ok {
				t.Fatalf("unexpected result type %T", result)
			}
			if !strings.Contains(reply.Content[0].Text, testCase.want) {
				t.Fatalf("text %q does not contain %q", reply.Content[0].Text, testCase.want)
			}
			if testCase.wantOK != nil && reply.Details["ok"] != testCase.wantOK {
				t.Fatalf("details.ok = %v, want %v", reply.Details["ok"], testCase.wantOK)
			}
		})
	}
}

func TestToolExecuteAcceptsDocumentedAliases(t *testing.T) {
	srv := newServer()
	result, rpcErr, _ := srv.dispatch(request{
		Method: "tool.execute",
		Params: json.RawMessage(`{"toolCallId":"call-3","toolName":"kaden_call","params":{"action":"ping"}}`),
	})
	if rpcErr != nil {
		t.Fatalf("unexpected error: %v", rpcErr)
	}
	reply := result.(toolResult)
	if !strings.Contains(reply.Content[0].Text, "pong") {
		t.Fatalf("text = %q", reply.Content[0].Text)
	}
}

func TestUnknownMethodAndToolReportRpcErrors(t *testing.T) {
	srv := newServer()
	_, rpcErr, _ := srv.dispatch(request{Method: "teleport"})
	if rpcErr == nil || rpcErr.Code != codeMethodNotFound {
		t.Fatalf("rpcErr = %+v, want %d", rpcErr, codeMethodNotFound)
	}

	_, rpcErr, _ = srv.dispatch(request{
		Method: "tool.execute",
		Params: json.RawMessage(`{"tool":"kaden_warp","arguments":{}}`),
	})
	if rpcErr == nil || rpcErr.Code != codeMethodNotFound {
		t.Fatalf("rpcErr = %+v, want %d", rpcErr, codeMethodNotFound)
	}
}

func TestShutdownRepliesOkAndStops(t *testing.T) {
	srv := newServer()
	result, rpcErr, stop := srv.dispatch(request{Method: "shutdown"})
	if rpcErr != nil {
		t.Fatalf("unexpected error: %v", rpcErr)
	}
	if !stop {
		t.Fatalf("shutdown must stop the daemon")
	}
	reply, ok := result.(map[string]any)
	if !ok || reply["ok"] != true {
		t.Fatalf("result = %+v", result)
	}
}

func TestServeRoundTripsNewlineDelimitedJSONRPC(t *testing.T) {
	stdin := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"pluginId":"dennou-kaden","tools":["kaden_status","kaden_call"],"config":{}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tool.execute","params":{"toolCallId":"call-4","tool":"kaden_status","arguments":{}}}`,
		`not json at all`,
		`{"jsonrpc":"2.0","method":"ping"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tool.execute","params":{"toolCallId":"call-5","tool":"kaden_call","arguments":{"action":"ping"}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"shutdown","params":{}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tool.execute","params":{"tool":"kaden_status"}}`,
	}, "\n")

	var stdout bytes.Buffer
	if err := newServer().serve(strings.NewReader(stdin), &stdout); err != nil {
		t.Fatalf("serve returned error: %v", err)
	}

	lines := []string{}
	for _, line := range strings.Split(strings.TrimSpace(stdout.String()), "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	// Malformed line, notification, and post-shutdown request must not answer.
	if len(lines) != 4 {
		t.Fatalf("wrote %d response lines, want 4:\n%s", len(lines), stdout.String())
	}

	ids := make([]float64, 0, len(lines))
	for _, line := range lines {
		var decoded struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Result  json.RawMessage `json:"result"`
			Error   *rpcError       `json:"error"`
		}
		if err := json.Unmarshal([]byte(line), &decoded); err != nil {
			t.Fatalf("response is not JSON: %v (%s)", err, line)
		}
		if decoded.JSONRPC != "2.0" {
			t.Fatalf("jsonrpc = %q", decoded.JSONRPC)
		}
		if decoded.Error != nil {
			t.Fatalf("unexpected error response: %s", line)
		}
		var id float64
		if err := json.Unmarshal(decoded.ID, &id); err != nil {
			t.Fatalf("id is not numeric: %s", line)
		}
		ids = append(ids, id)
	}
	for index, want := range []float64{1, 2, 3, 4} {
		if ids[index] != want {
			t.Fatalf("response ids = %v, want 1,2,3,4", ids)
		}
	}
}

func TestDisabledConfigSurfacesInState(t *testing.T) {
	srv := newServer()
	_, _, _ = srv.dispatch(request{
		Method: "initialize",
		Params: json.RawMessage(`{"protocolVersion":1,"pluginId":"dennou-kaden","config":{"enabled":false}}`),
	})
	if !strings.Contains(srv.state(), "disabled") {
		t.Fatalf("state = %q, want disabled", srv.state())
	}
	if srv.enabled() {
		t.Fatalf("enabled() = true, want false")
	}
}

func TestAdvertisedToolsFallsBackToManifestTools(t *testing.T) {
	srv := newServer()
	if got := strings.Join(srv.advertisedTools(), ","); got != "kaden_call,kaden_status" {
		t.Fatalf("advertisedTools() = %q", got)
	}
}
