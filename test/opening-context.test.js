const assert = require("node:assert/strict");
const test = require("node:test");

const {
  extractOpeningContext,
  isExternalOpeningCandidate,
  isWithinOpeningWindow,
} = require("../src/utils/tickets/openingContext");

test("extracts modal answers from embed fields", () => {
  const message = {
    content: "",
    embeds: [{
      title: "New ticket",
      description: "Ticket information",
      fields: [
        { name: "Issue", value: "My payment failed" },
        { name: "Order ID", value: "12345" },
      ],
    }],
  };

  const text = extractOpeningContext(message);
  assert.match(text, /Issue: My payment failed/);
  assert.match(text, /Order ID: 12345/);
});

test("external bot embed is an opening candidate", () => {
  const message = {
    guild: { id: "g1" },
    channel: { id: "c1" },
    author: { id: "ticket-bot", bot: true },
    embeds: [{ fields: [{ name: "Problem", value: "I cannot access my order" }] }],
  };
  assert.equal(isExternalOpeningCandidate(message, "pixy"), true);
});

test("Pixy messages are never opening candidates", () => {
  const message = {
    guild: { id: "g1" },
    channel: { id: "c1" },
    author: { id: "pixy", bot: true },
    content: "Pixy ticket controls are ready",
    embeds: [],
  };
  assert.equal(isExternalOpeningCandidate(message, "pixy"), false);
});

test("normal user messages are not opening candidates", () => {
  const message = {
    guild: { id: "g1" },
    channel: { id: "c1" },
    author: { id: "user", bot: false },
    content: "I need help with my order",
    embeds: [],
  };
  assert.equal(isExternalOpeningCandidate(message, "pixy"), false);
});

test("opening context is limited to the initial ticket window", () => {
  const now = Date.now();
  const ticket = { createdAt: new Date(now - 5000) };
  assert.equal(isWithinOpeningWindow({ createdTimestamp: now - 4000 }, ticket, now), true);
  assert.equal(isWithinOpeningWindow({ createdTimestamp: now - 60000 }, { createdAt: new Date(now - 60000) }, now), false);
});
