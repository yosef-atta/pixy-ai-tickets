const SETUP_VALIDATION_CHANNEL_ID = "setup-validation";
const SETUP_VALIDATION_SUCCESS = "setup_validation_success";
const SETUP_VALIDATION_FAILED = "setup_validation_failed";

const PROVIDER_HEALTH_STATUSES = Object.freeze([
  SETUP_VALIDATION_SUCCESS,
  SETUP_VALIDATION_FAILED,
  "success",
  "provider_error",
  "rate_limited",
  "empty_response",
]);

function getDefaultPrisma() {
  return require("../config/prisma").prisma;
}

function cleanText(value, max = 900) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3)).trim()}...`;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    };
  }

  const prompt = usage.prompt_tokens ?? usage.promptTokenCount ?? null;
  const completion = usage.completion_tokens ?? usage.candidatesTokenCount ?? null;
  const total = usage.total_tokens ?? usage.totalTokenCount ?? null;

  return {
    promptTokens: Number.isFinite(Number(prompt)) ? Number(prompt) : null,
    completionTokens: Number.isFinite(Number(completion)) ? Number(completion) : null,
    totalTokens: Number.isFinite(Number(total)) ? Number(total) : null,
  };
}

async function recordProviderSetupValidation({
  guildId,
  userId = null,
  provider,
  model = null,
  ok,
  probe = null,
  error = null,
} = {}, options = {}) {
  const client = options.client || getDefaultPrisma();
  const usage = normalizeUsage(probe?.usage);

  return client.aiUsageLog.create({
    data: {
      guildId: String(guildId || "").trim(),
      channelId: SETUP_VALIDATION_CHANNEL_ID,
      userId: userId ? String(userId) : null,
      provider: String(provider || "").trim().toLowerCase(),
      model: String(probe?.model || model || "").trim() || null,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      status: ok ? SETUP_VALIDATION_SUCCESS : SETUP_VALIDATION_FAILED,
      error: ok ? null : cleanText(error?.message || error || "Provider live validation failed."),
    },
  });
}

async function getLatestProviderHealthEvent(guildId, provider, options = {}) {
  const client = options.client || getDefaultPrisma();
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (!normalizedGuildId || !normalizedProvider) return null;

  return client.aiUsageLog.findFirst({
    where: {
      guildId: normalizedGuildId,
      provider: normalizedProvider,
      status: { in: PROVIDER_HEALTH_STATUSES },
    },
    orderBy: { createdAt: "desc" },
  });
}

function buildProviderHealthIssue(event, providerDefinition) {
  if (!event) return null;

  const displayName = providerDefinition?.displayName || event.provider || "AI provider";
  const status = String(event.status || "");
  if ([SETUP_VALIDATION_SUCCESS, "success"].includes(status)) return null;

  if (status === "rate_limited") {
    return `${displayName} is currently rate-limited. The credential may still be valid; retry after the provider limit resets.`;
  }

  if (status === "empty_response") {
    return `${displayName} most recently returned an empty response. Re-run the provider/model validation in AI Provider setup.`;
  }

  const detail = cleanText(event.error || "Provider request failed.", 600);
  if (status === SETUP_VALIDATION_FAILED) {
    return `${displayName} live validation failed: ${detail}`;
  }

  if (status === "provider_error") {
    return `${displayName} most recently failed during a real ticket reply: ${detail}`;
  }

  return null;
}

module.exports = {
  PROVIDER_HEALTH_STATUSES,
  SETUP_VALIDATION_CHANNEL_ID,
  SETUP_VALIDATION_FAILED,
  SETUP_VALIDATION_SUCCESS,
  buildProviderHealthIssue,
  cleanText,
  getLatestProviderHealthEvent,
  normalizeUsage,
  recordProviderSetupValidation,
};
