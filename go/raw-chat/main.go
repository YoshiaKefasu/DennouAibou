package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

var writeMu sync.Mutex

func main() {
	socketPath := flag.String("socket", "", "Path to unix domain socket or TCP address (127.0.0.1:PORT)")
	ppid := flag.Int("ppid", 0, "Parent Process ID to monitor (reserved for future use)")

	flag.Parse()

	if *socketPath == "" {
		fmt.Fprintln(os.Stderr, "Missing -socket argument")
		os.Exit(1)
	}

	emitLog("Starting raw-chat sidecar on %s", *socketPath)

	// Setup listener depending on OS.
	var listener net.Listener
	var err error

	if runtime.GOOS == "windows" {
		// TCP on loopback for Windows.
		listener, err = net.Listen("tcp", *socketPath)
	} else {
		listener, err = net.Listen("unix", *socketPath)
	}

	if err != nil {
		emitLog("Failed to listen: %v", err)
		os.Exit(1)
	}
	defer listener.Close()

	// Start stdin close detection goroutine.
	// When the parent Node.js process dies, stdin closes and we exit cleanly.
	go watchStdin()

	// Also watch for OS signals (SIGTERM, SIGINT) for clean shutdown.
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigChan
		emitLog("Received signal %v, shutting down", sig)
		os.Exit(0)
	}()

	_ = ppid // Reserved for future use.

	for {
		conn, err := listener.Accept()
		if err != nil {
			emitLog("Failed to accept connection: %v", err)
			continue
		}
		go handleConnection(conn)
	}
}

// watchStdin monitors stdin for close (EOF). When the parent Node.js process
// dies, stdin closes and this goroutine triggers a clean shutdown.
func watchStdin() {
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		// Discard any data on stdin; we only care about the close.
	}
	// stdin closed (EOF or error).
	emitLog("stdin closed (parent process exited), shutting down in 5s")
	// Give pending connections time to drain.
	time.Sleep(5 * time.Second)
	os.Exit(0)
}

func handleConnection(conn net.Conn) {
	defer conn.Close()

	scanner := bufio.NewScanner(conn)
	buf := make([]byte, 0, 1024*1024)
	scanner.Buffer(buf, 4*1024*1024) // 4MB max

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var req RPCRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			emitLog("Parse error: %v", err)
			continue
		}

		switch req.Method {
		case "raw_chat.index_session":
			go handleIndexSession(conn, req)
		case "raw_chat.search":
			go handleSearch(conn, req)
		case "raw_chat.backfill":
			go handleBackfill(conn, req)
		case "ping":
			if err := sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: "pong", ID: req.ID}); err != nil {
				emitLog("ping response write failed: %v", err)
				return
			}
		default:
			if err := sendResponse(conn, RPCResponse{
				JSONRPC: "2.0",
				Error:   &RPCError{Code: -32601, Message: "Method not found"},
				ID:      req.ID,
			}); err != nil {
				emitLog("method not found response write failed: %v", err)
				return
			}
		}
	}
}

func handleIndexSession(conn net.Conn, req RPCRequest) {
	var params IndexSessionParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		if sendErr := sendResponse(conn, RPCResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32602, Message: "Invalid params: " + err.Error()},
			ID:      req.ID,
		}); sendErr != nil {
			emitLog("index session invalid params response write failed: %v", sendErr)
		}
		return
	}

	if params.SessionFile == "" || params.AgentID == "" {
		if sendErr := sendResponse(conn, RPCResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32602, Message: "session_file and agent_id are required"},
			ID:      req.ID,
		}); sendErr != nil {
			emitLog("index session missing params response write failed: %v", sendErr)
		}
		return
	}

	// Sanitize AgentID to prevent path injection.
	if strings.Contains(params.AgentID, "/") || strings.Contains(params.AgentID, "..") || filepath.Base(params.AgentID) != params.AgentID {
		if sendErr := sendResponse(conn, RPCResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32602, Message: "invalid agent ID"},
			ID:      req.ID,
		}); sendErr != nil {
			emitLog("index session invalid agent_id response write failed: %v", sendErr)
		}
		return
	}

	db, err := OpenDB(params.AgentID)
	if err != nil {
		if sendErr := sendResponse(conn, RPCResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32000, Message: "Failed to open DB: " + err.Error()},
			ID:      req.ID,
		}); sendErr != nil {
			emitLog("index session open DB response write failed: %v", sendErr)
		}
		return
	}
	defer db.Close()

	indexed, skipped, errors := IndexSessionFile(db, params.SessionFile, params.AgentID, params.SessionKey)

	if sendErr := sendResponse(conn, RPCResponse{
		JSONRPC: "2.0",
		Result:  IndexSessionResult{Indexed: indexed, Skipped: skipped, Errors: errors},
		ID:      req.ID,
	}); sendErr != nil {
		emitLog("index session result response write failed: %v", sendErr)
	}
}

func handleSearch(conn net.Conn, req RPCRequest) {
	var params SearchParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		if sendErr := sendResponse(conn, RPCResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32602, Message: "Invalid params: " + err.Error()},
			ID:      req.ID,
		}); sendErr != nil {
			emitLog("search invalid params response write failed: %v", sendErr)
		}
		return
	}

	if params.AgentID == "" {
		if sendErr := sendResponse(conn, RPCResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32602, Message: "agent_id is required"},
			ID:      req.ID,
		}); sendErr != nil {
			emitLog("search missing agent_id response write failed: %v", sendErr)
		}
		return
	}

	// Sanitize AgentID to prevent path injection.
	if strings.Contains(params.AgentID, "/") || strings.Contains(params.AgentID, "..") || filepath.Base(params.AgentID) != params.AgentID {
		if sendErr := sendResponse(conn, RPCResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32602, Message: "invalid agent ID"},
			ID:      req.ID,
		}); sendErr != nil {
			emitLog("search invalid agent_id response write failed: %v", sendErr)
		}
		return
	}

	db, err := OpenDB(params.AgentID)
	if err != nil {
		if sendErr := sendResponse(conn, RPCResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32000, Message: "Failed to open DB: " + err.Error()},
			ID:      req.ID,
		}); sendErr != nil {
			emitLog("search open DB response write failed: %v", sendErr)
		}
		return
	}
	defer db.Close()

	results := Search(db, params)

	if sendErr := sendResponse(conn, RPCResponse{
		JSONRPC: "2.0",
		Result:  results,
		ID:      req.ID,
	}); sendErr != nil {
		emitLog("search result response write failed: %v", sendErr)
	}
}

func handleBackfill(conn net.Conn, req RPCRequest) {
	var params BackfillParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		if sendErr := sendResponse(conn, RPCResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32602, Message: "Invalid params: " + err.Error()},
			ID:      req.ID,
		}); sendErr != nil {
			emitLog("backfill invalid params response write failed: %v", sendErr)
		}
		return
	}

	if params.AgentID == "" {
		if sendErr := sendResponse(conn, RPCResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32602, Message: "agent_id is required"},
			ID:      req.ID,
		}); sendErr != nil {
			emitLog("backfill missing agent_id response write failed: %v", sendErr)
		}
		return
	}

	// Sanitize AgentID to prevent path injection.
	if strings.Contains(params.AgentID, "/") || strings.Contains(params.AgentID, "..") || filepath.Base(params.AgentID) != params.AgentID {
		if sendErr := sendResponse(conn, RPCResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32602, Message: "invalid agent ID"},
			ID:      req.ID,
		}); sendErr != nil {
			emitLog("backfill invalid agent_id response write failed: %v", sendErr)
		}
		return
	}

	db, err := OpenDB(params.AgentID)
	if err != nil {
		if sendErr := sendResponse(conn, RPCResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32000, Message: "Failed to open DB: " + err.Error()},
			ID:      req.ID,
		}); sendErr != nil {
			emitLog("backfill open DB response write failed: %v", sendErr)
		}
		return
	}
	defer db.Close()

	// Use default session dir if not provided.
	sessionDir := params.SessionDir
	if sessionDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			if sendErr := sendResponse(conn, RPCResponse{
				JSONRPC: "2.0",
				Error:   &RPCError{Code: -32000, Message: "Failed to get home dir: " + err.Error()},
				ID:      req.ID,
			}); sendErr != nil {
				emitLog("backfill home dir response write failed: %v", sendErr)
			}
			return
		}
		sessionDir = home + "/.openclaw/agents/" + params.AgentID + "/sessions"
	}

	result := BackfillSessionFiles(db, sessionDir, params.AgentID)

	if sendErr := sendResponse(conn, RPCResponse{
		JSONRPC: "2.0",
		Result:  result,
		ID:      req.ID,
	}); sendErr != nil {
		emitLog("backfill result response write failed: %v", sendErr)
	}
}

func sendResponse(conn net.Conn, resp RPCResponse) error {
	data, err := json.Marshal(resp)
	if err != nil {
		return fmt.Errorf("marshal response: %w", err)
	}
	data = append(data, '\n')
	writeMu.Lock()
	_, writeErr := conn.Write(data)
	writeMu.Unlock()
	if writeErr != nil {
		return fmt.Errorf("write response: %w", writeErr)
	}
	return nil
}

func emitLog(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}
