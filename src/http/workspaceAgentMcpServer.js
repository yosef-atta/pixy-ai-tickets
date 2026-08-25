const http = require("node:http");
const {
  completeWorkspaceAgentDelivery,
} = require("../ai/workspaceAgentBridge");

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 256 * 1024;

const SEND_TICKET_REPLY_TOOL = Object.freeze({
  name: "send_ticket_reply",
  title: "Send Pixy ticket reply",
  description:
    "Deliver the final user-facing reply for a Pixy Discord support request. Use the exact one-time delivery_token supplied in the Pixy Workspace Agent trigger input and call this tool exactly once for that request.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      delivery_token: {
        type: "string",
        description: "The exact short-lived delivery token supplied by Pixy in the current trigger input.",
      },
      reply: {
        type: "string",
        description: "The final user-facing Discord support reply. Do not include or reveal the delivery token.",
      },
    },
    required: ["delivery_token", "reply"],
  },
  securitySchemes: [{ type: "noauth" }],
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
});

function jsonRpcError(id, code, message, data = undefined) {
  return {
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function toolText(text, { isError = false } = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent: {},
    ...(isError ? { isError: true } : {}),
  };
}

function mapDeliveryFailure(code) {
  if (code === "delivery_token_required") return "Pixy delivery token is required.";
  if (code === "delivery_token_invalid") return "Pixy delivery token is invalid or no longer available.";
  if (code === "delivery_token_expired") return "Pixy delivery token expired before the reply was delivered.";
  if (code === "delivery_reply_invalid") return "The Pixy reply was empty or invalid.";
  return "Pixy could not accept this delivery. The request may already be closed or expired.";
}

async function handleWorkspaceAgentMcpMessage(message, options = {}) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request.");
  }

  const id = message.id;
  const method = String(message.method || "");

  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return null;
  }

  if (method === "initialize") {
    const requestedVersion = String(message.params?.protocolVersion || "").trim();
    return jsonRpcResult(id, {
      protocolVersion: requestedVersion || DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "pixy-workspace-agent-bridge",
        version: "1.0.0",
      },
      instructions:
        "For Pixy bridge requests, call send_ticket_reply exactly once with the exact one-time delivery_token supplied in the trigger input and the final user-facing reply.",
    });
  }

  if (method === "ping") {
    return jsonRpcResult(id, {});
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, { tools: [SEND_TICKET_REPLY_TOOL] });
  }

  if (method === "tools/call") {
    const toolName = String(message.params?.name || "");
    if (toolName !== SEND_TICKET_REPLY_TOOL.name) {
      return jsonRpcResult(
        id,
        toolText(`Unknown Pixy tool: ${toolName || "(missing)"}.`, { isError: true })
      );
    }

    const args = message.params?.arguments || {};
    const completeDelivery = options.completeDelivery || completeWorkspaceAgentDelivery;
    const result = await completeDelivery({
      deliveryToken: args.delivery_token,
      reply: args.reply,
    });

    if (!result?.ok) {
      return jsonRpcResult(id, toolText(mapDeliveryFailure(result?.code), { isError: true }));
    }

    return jsonRpcResult(
      id,
      toolText(
        result.duplicate
          ? "Pixy already accepted this reply; no duplicate Discord reply will be sent."
          : "Pixy accepted the reply for delivery to the Discord ticket."
      )
    );
  }

  return jsonRpcError(id, -32601, `Method not found: ${method || "(missing)"}.`);
}

async function handleWorkspaceAgentMcpPayload(payload, options = {}) {
  if (Array.isArray(payload)) {
    if (payload.length === 0) return jsonRpcError(null, -32600, "Invalid empty JSON-RPC batch.");
    const results = [];
    for (const item of payload) {
      const result = await handleWorkspaceAgentMcpMessage(item, options);
      if (result) results.push(result);
    }
    return results.length ? results : null;
  }
  return handleWorkspaceAgentMcpMessage(payload, options);
}

function sendJson(response, statusCode, payload, protocolVersion = DEFAULT_PROTOCOL_VERSION) {
  const body = payload === null ? "" : JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "MCP-Protocol-Version": protocolVersion,
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error("MCP request body is too large.");
        error.code = "mcp_body_too_large";
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : null);
      } catch (cause) {
        const error = new Error("Invalid MCP JSON request body.");
        error.code = "mcp_invalid_json";
        error.cause = cause;
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function createWorkspaceAgentMcpHttpServer(options = {}) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === HEALTH_PATH) {
      sendJson(response, 200, { ok: true, service: "pixy-workspace-agent-bridge" });
      return;
    }

    if (url.pathname !== MCP_PATH) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    try {
      const payload = await readJsonBody(request);
      if (!payload) {
        sendJson(response, 400, jsonRpcError(null, -32600, "JSON-RPC request body is required."));
        return;
      }

      const result = await handleWorkspaceAgentMcpPayload(payload, options);
      if (result === null) {
        response.writeHead(202, {
          "Cache-Control": "no-store",
          "MCP-Protocol-Version": request.headers["mcp-protocol-version"] || DEFAULT_PROTOCOL_VERSION,
        });
        response.end();
        return;
      }

      sendJson(
        response,
        200,
        result,
        request.headers["mcp-protocol-version"] || DEFAULT_PROTOCOL_VERSION
      );
    } catch (error) {
      const status = error?.code === "mcp_body_too_large" ? 413 : 400;
      sendJson(response, status, jsonRpcError(null, -32700, error?.message || "Invalid MCP request."));
    }
  });
}

function startWorkspaceAgentMcpServer({
  host = "127.0.0.1",
  port = 3100,
  ...options
} = {}) {
  const server = createWorkspaceAgentMcpHttpServer(options);
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

module.exports = {
  DEFAULT_PROTOCOL_VERSION,
  HEALTH_PATH,
  MCP_PATH,
  SEND_TICKET_REPLY_TOOL,
  createWorkspaceAgentMcpHttpServer,
  handleWorkspaceAgentMcpMessage,
  handleWorkspaceAgentMcpPayload,
  startWorkspaceAgentMcpServer,
};
