function createProviderError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function extractErrorMessage(payload) {
  if (!payload) return null;
  if (typeof payload === "string") return payload.trim() || null;
  return (
    payload.error?.message ||
    payload.message ||
    payload.detail ||
    payload.error_description ||
    null
  );
}

async function parseResponsePayload(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestJson({
  provider,
  url,
  method = "GET",
  headers = {},
  body,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw createProviderError(
      "provider_fetch_unavailable",
      `HTTP requests are unavailable for ${provider || "AI provider"}.`,
      { provider: provider || null }
    );
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    throw createProviderError(
      "provider_network_error",
      `${provider || "AI provider"} request failed before receiving a response.`,
      { provider: provider || null, cause }
    );
  }

  const payload = await parseResponsePayload(response);
  if (!response.ok) {
    const detail = extractErrorMessage(payload);
    throw createProviderError(
      "provider_http_error",
      detail || `${provider || "AI provider"} returned HTTP ${response.status}.`,
      {
        provider: provider || null,
        status: response.status,
        response: { status: response.status },
      }
    );
  }

  return payload;
}

function normalizeMessageText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content === null || content === undefined) return "";
  return String(content).trim();
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => ({
      role: String(message?.role || "user").trim().toLowerCase(),
      content: normalizeMessageText(message?.content),
    }))
    .filter((message) => message.content);
}

module.exports = {
  createProviderError,
  extractErrorMessage,
  normalizeMessageText,
  normalizeMessages,
  requestJson,
};
