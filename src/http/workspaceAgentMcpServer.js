const http = require("node:http");
const {
  completeWorkspaceAgentDelivery,
} = require("../ai/workspaceAgentBridge");
const {
  completeWorkspaceAgentActionDelivery,
} = require("../ai/workspaceAgentActionBridge");
const {
  TICKET_ACTIONS,
} = require("../utils/tickets/actions/ticketActionTypes");

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 256 * 1024;
const NOAUTH = Object.freeze([{ type: "noauth" }]);

const SEND_TICKET_REPLY_TOOL = Object.freeze({
  name: "send_ticket_reply",
  title: "Send Pixy ticket reply",
  description:
    "Deliver a normal final user-facing reply for a Pixy Discord support request. Use the exact one-time delivery_token supplied in the current Pixy trigger. Do not call this after requesting a ticket action.",
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
  securitySchemes: NOAUTH,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
});

const CLOSE_TICKET_TOOL = Object.freeze({
  name: "close_ticket",
  title: "Request Pixy ticket close",
  description:
    "Request closing the current Discord ticket. Use only when Pixy's supplied server context permits agent actions and the current user explicitly asks to close/end/delete/finish the ticket. Pixy revalidates plan, settings, current-message close intent, ticket surface, and Discord permissions before execution. Thread tickets cannot be closed by Pixy.",
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
        description: "Short user-facing message in the user's language accompanying the close request.",
      },
    },
    required: ["delivery_token", "reply"],
  },
  securitySchemes: NOAUTH,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
});

const RENAME_TICKET_TOOL = Object.freeze({
  name: "rename_ticket",
  title: "Request Pixy ticket rename",
  description:
    "Request renaming the current Discord ticket channel. Use only when Pixy's supplied server context permits agent actions and a clearer support-related name is warranted. Pixy sanitizes and revalidates the name, plan, settings, ticket surface, safety rules, and Discord permissions before execution. Thread tickets cannot be renamed by Pixy.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      delivery_token: {
        type: "string",
        description: "The exact short-lived delivery token supplied by Pixy in the current trigger input.",
      },
      name: {
        type: "string",
        description: "Requested short English Discord-channel-friendly ticket name, such as billing-refund or account-review.",
      },
      reply: {
        type: "string",
        description: "Short user-facing message in the user's language accompanying the rename request.",
      },
    },
    required: ["delivery_token", "name", "reply"],
  },
  securitySchemes: NOAUTH,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
});

const ESCALATE_TICKET_TOOL = Object.freeze({
  name: "escalate_ticket",
  title: "Request Pixy human escalation",
  description:
    "Request handoff of the current Discord ticket to one configured Pixy Human Support route. Use exactly a configured role ID from Pixy's supplied server context; never invent one. Pixy revalidates plan, settings, ticket state, route configuration, ticket surface, and Discord permissions before execution. Thread escalation remains non-destructive Smart Overlay handoff.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      delivery_token: {
        type: "string",
        description: "The exact short-lived delivery token supplied by Pixy in the current trigger input.",
      },
      role_id: {
        type: "string",
        description: "Exactly one configured support role ID supplied in PIXY SERVER CONTEXT.",
      },
      reason: {
        type: "string",
        description: "Short reason why human support is needed.",
      },
      name: {
        type: "string",
        description: "Optional short English Discord-channel-friendly escalation name, such as billing-refund.",
      },
      reply: {
        type: "string",
        description: "Short user-facing message in the user's language. Do not include role mentions; Pixy handles notifications safely.",
      },
    },
    required: ["delivery_token", "role_id", "reason", "reply"],
  },
  securitySchemes: NOAUTH,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
});

const PIXY_MCP_TOOLS = Object.freeze([
  SEND_TICKET_REPLY_TOOL,
  CLOSE_TICKET_TOOL,
  RENAME_TICKET_TOOL,
  ESCALATE_TICKET_TOOL,
]);

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
  if (code === "delivery_token_expired") return "Pixy delivery token expired before the result was delivered.";
  if (code === "delivery_reply_invalid") return "The Pixy reply was empty or invalid.";
  if (code === "delivery_action_invalid") return "The Pixy ticket action request was invalid.";
  return "Pixy could not accept this delivery. The request may already be closed or expired.";
}

function getActionFromToolName(toolName) {
  if (toolName === CLOSE_TICKET_TOOL.name) return TICKET_ACTIONS.CLOSE_TICKET;
  if (toolName === RENAME_TICKET_TOOL.name) return TICKET_ACTIONS.RENAME_TICKET;
  if (toolName === ESCALATE_TICKET_TOOL.name) return TICKET_ACTIONS.ESCALATE_TICKET;
  return null;
}

function getActionData(toolName, args = {}) {
  if (toolName === RENAME_TICKET_TOOL.name) {
    return { name: args.name };
  }
  if (toolName === ESCALATE_TICKET_TOOL.name) {
    return {
      roleId: args.role_id,
      reason: args.reason,
      name: args.name,
    };
  }
  return {};
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
        version: "1.1.0",
      },
      instructions: [
        "For every Pixy bridge request, call exactly one Pixy delivery tool with the exact one-time delivery_token supplied in the trigger input.",
        "Use send_ticket_reply for normal answers.",
        "Use close_ticket, rename_ticket, or escalate_ticket only when Pixy's supplied server context permits that action and the user request satisfies Pixy's action policy.",
        "Action tools submit requests into Pixy's existing validation/execution pipeline; they never bypass Pixy settings, plan entitlements, permissions, thread safety, close-intent checks, or configured support routes.",
      ].join(" "),
    });
  }

  if (method === "ping") {
    return jsonRpcResult(id, {});
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, { tools: PIXY_MCP_TOOLS });
  }

  if (method === "tools/call") {
    const toolName = String(message.params?.name || "");
    const args = message.params?.arguments || {};

    if (toolName === SEND_TICKET_REPLY_TOOL.name) {
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
            ? "Pixy already accepted a result for this request; no duplicate Discord reply or action will be produced."
            : "Pixy accepted the reply for delivery to the Discord ticket."
        )
      );
    }

    const action = getActionFromToolName(toolName);
    if (action) {
      const completeActionDelivery =
        options.completeActionDelivery || completeWorkspaceAgentActionDelivery;
      const result = await completeActionDelivery({
        deliveryToken: args.delivery_token,
        action,
        text: args.reply,
        data: getActionData(toolName, args),
      });

      if (!result?.ok) {
        return jsonRpcResult(id, toolText(mapDeliveryFailure(result?.code), { isError: true }));
      }

      return jsonRpcResult(
        id,
        toolText(
          result.duplicate
            ? "Pixy already accepted a result for this request; the duplicate action request was ignored."
            : `Pixy accepted the ${action} request for its normal validation and execution pipeline.`
        )
      );
    }

    return jsonRpcResult(
      id,
      toolText(`Unknown Pixy tool: ${toolName || "(missing)"}.`, { isError: true })
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
  CLOSE_TICKET_TOOL,
  DEFAULT_PROTOCOL_VERSION,
  ESCALATE_TICKET_TOOL,
  HEALTH_PATH,
  MCP_PATH,
  PIXY_MCP_TOOLS,
  RENAME_TICKET_TOOL,
  SEND_TICKET_REPLY_TOOL,
  createWorkspaceAgentMcpHttpServer,
  getActionData,
  getActionFromToolName,
  handleWorkspaceAgentMcpMessage,
  handleWorkspaceAgentMcpPayload,
  startWorkspaceAgentMcpServer,
};
