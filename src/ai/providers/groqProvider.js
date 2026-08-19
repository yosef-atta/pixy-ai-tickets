const GroqSDK = require("groq-sdk");
const {
  DEFAULT_GROQ_MODEL,
  listGroqModels,
  validateGroqApiKey,
  validateGroqChatModel,
} = require("../groqModels");
const { stripThinkBlocks } = require("../sanitizeModelOutput");

const Groq = GroqSDK.default || GroqSDK;
const GROQ_PROVIDER_ID = "groq";
const GROQ_CREDENTIAL_TYPE = "groq-api-key";

function createMissingCredentialError() {
  const error = new Error(
    "This server must configure a Groq API key in /pixy-settings."
  );
  error.code = "missing_guild_groq_api_key";
  error.provider = GROQ_PROVIDER_ID;
  return error;
}

async function generateGroqReply({
  messages,
  model,
  credential,
  apiKey,
  generation = {},
} = {}) {
  const key = String(credential || apiKey || "").trim();
  if (!key) throw createMissingCredentialError();

  // Construct per request so plaintext guild credentials are not retained in
  // an unbounded process-wide cache.
  const groq = new Groq({ apiKey: key });
  const selectedModel = String(model || DEFAULT_GROQ_MODEL).trim();
  const temperature = Number.isFinite(Number(generation.temperature))
    ? Number(generation.temperature)
    : 0.3;
  const maxOutputTokens = Number.isFinite(Number(generation.maxOutputTokens))
    ? Math.max(1, Number(generation.maxOutputTokens))
    : 500;

  const response = await groq.chat.completions.create({
    model: selectedModel,
    messages,
    temperature,
    max_completion_tokens: maxOutputTokens,
  });

  const rawContent = response.choices?.[0]?.message?.content || "";
  const content = stripThinkBlocks(rawContent);

  return {
    text: content,
    raw: response,
    usage: response.usage || null,
    model: response.model || selectedModel,
    provider: GROQ_PROVIDER_ID,
  };
}

const groqProvider = Object.freeze({
  id: GROQ_PROVIDER_ID,
  displayName: "Groq",
  defaultModel: DEFAULT_GROQ_MODEL,
  requiresCredential: true,
  credentialType: GROQ_CREDENTIAL_TYPE,
  credentialLabel: "Groq API Key",
  credentialPlaceholder: "gsk_...",
  generateReply: generateGroqReply,
  listModels: listGroqModels,
  validateCredential: validateGroqApiKey,
  validateModel({ credential, modelId }) {
    return validateGroqChatModel({
      apiKey: credential,
      modelId,
    });
  },
});

module.exports = {
  GROQ_CREDENTIAL_TYPE,
  GROQ_PROVIDER_ID,
  generateGroqReply,
  groqProvider,
};
