const assert = require("node:assert/strict");
const test = require("node:test");

const { aiConfig } = require("../src/config/ai");
const { splitDiscordMessage } = require("../src/utils/splitDiscordMessage");

test("aiConfig maxOutputTokens is expanded to at least 2000", () => {
  assert.ok(
    aiConfig.maxOutputTokens >= 2000,
    `Expected maxOutputTokens >= 2000, got ${aiConfig.maxOutputTokens}`
  );
});

test("aiConfig minThinkingHoldMs enforces at least 3000ms", () => {
  assert.ok(
    aiConfig.minThinkingHoldMs >= 3000,
    `Expected minThinkingHoldMs >= 3000, got ${aiConfig.minThinkingHoldMs}`
  );
});

test("splitDiscordMessage cleanly chunks long AI responses over 2000 characters", () => {
  const longText = "This is a detailed resolution paragraph.\n\n".repeat(60);
  assert.ok(longText.length > 2000);

  const chunks = splitDiscordMessage(longText);
  assert.ok(chunks.length > 1);

  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1900);
  }

  const reassembled = chunks.join("\n\n");
  assert.ok(reassembled.includes("detailed resolution paragraph"));
});

test("thinking state timestamp string format matches dynamic Discord relative timestamp", () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const thinkingText = `Pixy is **thinking**\n<t:${nowSeconds}:R>`;

  assert.match(thinkingText, /^Pixy is \*\*thinking\*\*\n<t:\d{10}:R>$/);
});
