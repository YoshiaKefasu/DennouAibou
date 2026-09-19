import crypto from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { loadConfig } from "../config/config.js";
import { logDebug, logWarn } from "../logger.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { jsonRpcError, type JsonRpcRequest } from "./mcp-http.protocol.js";
import {
  readMcpHttpBody,
  resolveMcpRequestContext,
  validateMcpLoopbackRequest,
  type McpRequestContextDeps,
} from "./mcp-http.request.js";
import {
  clearActiveMcpLoopbackRuntime,
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  McpLoopbackToolCache,
  setActiveMcpLoopbackRuntime,
  type McpLoopbackToolCacheDeps,
} from "./mcp-http.runtime.js";

export { createMcpLoopbackServerConfig, getActiveMcpLoopbackRuntime } from "./mcp-http.runtime.js";

export type McpLoopbackServerDeps = {
  loadConfig?: typeof loadConfig;
  resolveMainSessionKey?: McpRequestContextDeps["resolveMainSessionKey"];
  resolveGatewayScopedTools?: McpLoopbackToolCacheDeps["resolveGatewayScopedTools"];
};

export async function startMcpLoopbackServer(
  port = 0,
  deps: McpLoopbackServerDeps = {},
): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const loadConfigImpl = deps.loadConfig ?? loadConfig;
  const token = crypto.randomBytes(32).toString("hex");
  const toolCache = new McpLoopbackToolCache(
    deps.resolveGatewayScopedTools
      ? { resolveGatewayScopedTools: deps.resolveGatewayScopedTools }
      : {},
  );

  const httpServer = createHttpServer((req, res) => {
    if (!validateMcpLoopbackRequest({ req, res, token })) {
      return;
    }

    void (async () => {
      try {
        const body = await readMcpHttpBody(req);
        const parsed: JsonRpcRequest | JsonRpcRequest[] = JSON.parse(body);
        const cfg = loadConfigImpl();
        const requestContext = resolveMcpRequestContext(req, cfg, {
          ...(deps.resolveMainSessionKey
            ? { resolveMainSessionKey: deps.resolveMainSessionKey }
            : {}),
        });
        const scopedTools = toolCache.resolve({
          cfg,
          sessionKey: requestContext.sessionKey,
          messageProvider: requestContext.messageProvider,
          accountId: requestContext.accountId,
        });

        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const responses: object[] = [];
        for (const message of messages) {
          const response = await handleMcpJsonRpc({
            message,
            tools: scopedTools.tools,
            toolSchema: scopedTools.toolSchema,
          });
          if (response !== null) {
            responses.push(response);
          }
        }

        if (responses.length === 0) {
          res.writeHead(202);
          res.end();
          return;
        }

        const payload = Array.isArray(parsed)
          ? JSON.stringify(responses)
          : JSON.stringify(responses[0]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(payload);
      } catch (error) {
        logWarn(
          `mcp loopback: request handling failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("mcp loopback did not bind to a TCP port");
  }
  setActiveMcpLoopbackRuntime({ port: address.port, token });
  logDebug(`mcp loopback listening on 127.0.0.1:${address.port}`);

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (!error) {
            clearActiveMcpLoopbackRuntime(token);
          }
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
