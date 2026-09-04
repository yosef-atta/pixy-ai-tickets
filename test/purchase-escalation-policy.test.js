const assert = require("node:assert/strict");
const test = require("node:test");

const {
  IMMEDIATE_PURCHASE_HANDOFF_POLICY,
  buildTicketPrompt,
} = require("../src/ai/buildTicketPrompt");

function promptText(messages) {
  return messages.map((message) => message.content).join("\n\n");
}

function buildAdvertisingPrompt(userMessage) {
  return buildTicketPrompt({
    guildName: "Example Guild",
    channelName: "ticket-ads",
    userName: "Yosef",
    userMessage,
    recentMessages: [
      {
        speakerType: "user",
        authorName: "Yosef",
        content: "ايه الإعلانات المتاحة عندكم؟",
      },
      {
        speakerType: "assistant",
        authorName: "Pixy AI",
        content: "Epic is one of the available paid advertising packages.",
      },
    ],
    learnedQna: [],
    learnedFreeform: [
      {
        id: "ads-packages",
        title: "Advertising packages",
        content: "Epic is a paid advertising package available in this server.",
      },
    ],
    adminRoutes: [
      {
        id: "ads-route",
        roleId: "role-ads",
        roleName: "ads",
        description: "Handles advertising package purchases and orders.",
      },
    ],
  });
}

test("premium prompt requires same-turn escalation for clear purchase intent", () => {
  const messages = buildAdvertisingPrompt("انا عايز الـ Epic دي");
  const text = promptText(messages);
  const systemText = messages[0].content;

  assert.equal(messages[0].role, "system");
  assert.match(text, /Yosef asked:\nانا عايز الـ Epic دي/);
  assert.match(text, /Handles advertising package purchases and orders/);
  assert.match(systemText, /Immediate purchase\/order handoff \(clarification\):/);
  assert.match(systemText, /request escalate_ticket immediately in the same turn/i);
  assert.match(systemText, /Do not ask for an extra confirmation/i);
  assert.match(systemText, /Do not re-explain the selected package or service before the handoff/i);
  assert.match(systemText, /عايز الـ Epic دي/);

  const genericUncertaintyRule = systemText.indexOf(
    "If you are not sure whether an action should happen, do not request an action."
  );
  const immediatePurchaseRule = systemText.indexOf(
    "Immediate purchase/order handoff (clarification):"
  );

  assert.ok(genericUncertaintyRule >= 0);
  assert.ok(immediatePurchaseRule > genericUncertaintyRule);
});

test("purchase handoff policy keeps information-only package questions non-transactional", () => {
  const messages = buildAdvertisingPrompt("ايه سعر Epic ومميزاتها؟");
  const systemText = messages[0].content;

  assert.ok(IMMEDIATE_PURCHASE_HANDOFF_POLICY.includes(
    "Questions that only ask for information"
  ));
  assert.match(
    systemText,
    /Questions that only ask for information, such as price, features, availability, or package details, are not purchase\/order intent by themselves/i
  );
  assert.match(systemText, /should be answered normally when the answer is safely available/i);
});
