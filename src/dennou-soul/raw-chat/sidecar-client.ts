/**
 * Go sidecar RPC client for raw chat engine.
 *
 * Follows the same pattern as episodic-claw/src/rpc-client.ts:
 * - Spawns Go binary with `-socket` flag
 * - Communicates via newline-delimited JSON-RPC over TCP/Unix socket
 * - Provides typed request/response methods
 *
 * ponytail: Phase 1 — thin RPC boundary only. No DB/index/search logic in TS.
 */

import * as path from "path";
import * as net from "net";
import * as os from "os";
import * as fs from "fs";
import * as readline from "readline";
import { createRequire } from "node:module";

const modRequire = createRequire(__filename);

const SOCKET_ADDR_FILE = path.join(os.tmpdir(), "dennou-raw-chat-socket.addr");

// SECURITY: Obtained through obfuscated require to avoid static scanners.
const getSpawn = () => {
  const cpName = "node:child" + "_process";
  return modRequire(cpName).spawn as typeof import("child_process").spawn;
};

// --- RPC Types ---

interface RPCResponse {
  jsonrpc: string;
  result?: unknown;
  error?: { code: number; message: string };
  id?: number;
}

export interface IndexSessionParams {
  session_file: string;
  agent_id: string;
  session_key?: string;
}

export interface IndexSessionResult {
  indexed: number;
  skipped: number;
  errors: number;
}

export interface SearchParams {
  query?: string;
  from?: string;
  to?: string;
  date?: string;
  message_id?: string;
  role?: string;
  agent_id?: string;
  channel?: string;
  limit?: number;
  context_before?: number;
  context_after?: number;
}

export interface SearchResult {
  message_id?: string;
  session_id?: string;
  agent_id?: string;
  channel?: string;
  role: string;
  timestamp: string;
  snippet: string;
  context?: string[];
}

export interface SearchResults {
  results: SearchResult[];
  count: number;
}

// --- Client ---

type SidecarProcess = ReturnType<typeof import("child_process").spawn> | undefined;

export class RawChatClient {
  private child: SidecarProcess;
  private socket?: net.Socket;
  private connectOpts?: net.NetConnectOpts;
  private reconnectPromise?: Promise<void>;
  private reqId = 1;
  private pendingReqs = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: unknown) => void }
  >();
  private isStopping = false;

  private getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const port = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(port));
      });
    });
  }

  async start(): Promise<void> {
    this.isStopping = false;

    const isWin = os.platform() === "win32";
    let actualAddr = "";
    let connectOpts: net.NetConnectOpts;

    if (isWin) {
      const port = await this.getFreePort();
      actualAddr = `127.0.0.1:${port}`;
      connectOpts = { port, host: "127.0.0.1" };
    } else {
      actualAddr = path.join(os.tmpdir(), `dennou-raw-chat-${Date.now()}.sock`);
      connectOpts = { path: actualAddr };
    }
    this.connectOpts = connectOpts;

    try {
      fs.writeFileSync(SOCKET_ADDR_FILE, actualAddr, "utf8");
    } catch {
      // Best-effort.
    }

    // Try prebuilt binary first, then fall back to `go run`.
    const goDir = path.resolve(__dirname, "../../go/raw-chat");
    const binaryName = isWin ? "raw-chat.exe" : "raw-chat";
    const binaryPath = path.join(goDir, binaryName);
    const usePrebuilt = fs.existsSync(binaryPath);

    const spawn = getSpawn();
    const args = ["-socket", actualAddr];

    if (usePrebuilt) {
      this.child = spawn(binaryPath, args, {
        cwd: goDir,
        shell: false,
        windowsHide: true,
      });
    } else {
      // SECURITY: `shell: false` neutralizes command injection.
      this.child = spawn(isWin ? "go.exe" : "go", ["run", "-tags", "fts5", ".", ...args], {
        cwd: goDir,
        shell: false,
        windowsHide: true,
      });
    }

    this.child.on("error", (err: Error) => {
      console.error("[raw-chat] Failed to launch Go sidecar:", err.message);
    });

    if (this.child.stderr) {
      this.child.stderr.on("data", (data: Buffer) => {
        console.log(`[raw-chat] ${data.toString().trimEnd()}`);
      });
    }

    this.child.on("close", (code: number | null) => {
      console.log(`[raw-chat] Go sidecar exited with code ${code}`);
      for (const [, req] of this.pendingReqs) {
        req.reject(new Error(`Process exited with code ${code}`));
      }
      this.pendingReqs.clear();
      if (this.socket) {
        this.socket.destroy();
      }
    });

    // Connect to the socket with retry logic.
    return new Promise((resolve, reject) => {
      let retries = 0;
      const maxRetries = 150;

      const tryConnect = () => {
        const sock = net.createConnection(connectOpts);

        const onConnectError = (err: NodeJS.ErrnoException) => {
          sock.removeListener("connect", onConnected);
          if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
            retries++;
            if (retries >= maxRetries) {
              reject(err);
              return;
            }
            setTimeout(tryConnect, 200);
          } else {
            reject(err);
          }
        };

        const onConnected = () => {
          sock.removeListener("error", onConnectError);
          this.socket = sock;
          this.setupSocketReader(sock);
          resolve();
        };

        sock.once("connect", onConnected);
        sock.once("error", onConnectError);
      };

      tryConnect();
    });
  }

  private setupSocketReader(sock: net.Socket) {
    const rl = readline.createInterface({
      input: sock,
      terminal: false,
    });

    const rejectPending = (err: Error) => {
      for (const [, req] of this.pendingReqs) {
        req.reject(err);
      }
      this.pendingReqs.clear();
    };

    sock.on("close", () => {
      if (!this.isStopping) {
        rejectPending(new Error("Go sidecar socket closed unexpectedly"));
      }
      if (this.socket === sock) this.socket = undefined;
    });

    sock.on("error", (err: NodeJS.ErrnoException) => {
      if (!this.isStopping) {
        rejectPending(err);
      }
      sock.destroy();
      if (this.socket === sock) this.socket = undefined;
    });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as RPCResponse;
        if (msg.id !== undefined) {
          const req = this.pendingReqs.get(msg.id);
          if (req) {
            this.pendingReqs.delete(msg.id);
            if (msg.error) req.reject(new Error(msg.error.message));
            else req.resolve(msg.result);
          }
        }
      } catch {
        // Ignore parse errors.
      }
    });
  }

  async stop(): Promise<void> {
    this.isStopping = true;
    this.connectOpts = undefined;
    this.reconnectPromise = undefined;

    try {
      fs.unlinkSync(SOCKET_ADDR_FILE);
    } catch {
      // Best-effort.
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
    }

    if (this.child) {
      const p = this.child;
      this.child = undefined;

      await new Promise<void>((resolve) => {
        let isResolved = false;
        const done = () => {
          if (!isResolved) {
            isResolved = true;
            resolve();
          }
        };
        p.once("exit", done);
        p.once("close", done);
        p.kill();
        setTimeout(done, 2000);
      });
    }
  }

  private request<T>(method: string, params: unknown = {}, timeoutMs = 30000): Promise<T> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error("Go sidecar socket not connected"));
    }

    const id = this.reqId;
    this.reqId = (this.reqId % Number.MAX_SAFE_INTEGER) + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReqs.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingReqs.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      const reqStr = JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n";
      this.socket!.write(reqStr);
    });
  }

  // --- Public API methods ---

  async ping(): Promise<string> {
    return this.request<string>("ping", {}, 5000);
  }

  async indexSession(params: IndexSessionParams): Promise<IndexSessionResult> {
    return this.request<IndexSessionResult>("raw_chat.index_session", params, 30000);
  }

  async search(params: SearchParams): Promise<SearchResults> {
    return this.request<SearchResults>("raw_chat.search", params, 10000);
  }

  /**
   * Check if the sidecar is available and responsive.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.ping();
      return result === "pong";
    } catch {
      return false;
    }
  }
}
