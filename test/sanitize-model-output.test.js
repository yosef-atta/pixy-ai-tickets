const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  convertMarkdownTables,
  sanitizeDiscordMarkdown,
  stripThinkBlocks,
} = require("../src/ai/sanitizeModelOutput");

test("removes a complete think block and keeps only the visible answer", () => {
  assert.equal(
    stripThinkBlocks("<think>private reasoning</think>\n\nVisible answer"),
    "Visible answer"
  );
});

test("removes multiple and mixed-case think blocks", () => {
  assert.equal(
    stripThinkBlocks("Before <THINK>one</THINK> middle <think>two</think> after"),
    "Before  middle  after"
  );
});

test("removes nested think blocks", () => {
  assert.equal(
    stripThinkBlocks("<think>outer <think>inner</think> outer</think>Answer"),
    "Answer"
  );
});

test("drops an unfinished think block and everything after it", () => {
  assert.equal(
    stripThinkBlocks("Visible first\n<think>unfinished private reasoning"),
    "Visible first"
  );
});

test("leaves ordinary text unchanged apart from whitespace normalization", () => {
  assert.equal(stripThinkBlocks("Hello\r\n\r\n\r\nWorld"), "Hello\n\nWorld");
});

test("converts markdown pipe tables into clean Discord bulleted lists", () => {
  const tableInput = [
    "Available plans:",
    "",
    "| Plan | Price | Features |",
    "| --- | --- | --- |",
    "| Basic | $5 | 100 tickets |",
    "| Pro | $15 | Unlimited tickets |",
  ].join("\n");

  const sanitized = sanitizeDiscordMarkdown(tableInput);
  assert.ok(!sanitized.includes("|"));
  assert.ok(sanitized.includes("- **Basic**"));
  assert.ok(sanitized.includes("**Price**: $5"));
  assert.ok(sanitized.includes("**Features**: 100 tickets"));
  assert.ok(sanitized.includes("- **Pro**"));
});

test("replaces HTML break tags and strips unsupported HTML tags", () => {
  const htmlInput = "Line 1<br>Line 2<br/><div><span>Line 3</span></div>";
  const sanitized = sanitizeDiscordMarkdown(htmlInput);
  assert.ok(!sanitized.includes("<br>"));
  assert.ok(!sanitized.includes("<div>"));
  assert.ok(!sanitized.includes("<span>"));
  assert.ok(sanitized.includes("Line 1\nLine 2\nLine 3"));
});
