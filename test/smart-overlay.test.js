const assert = require("node:assert/strict");
const test = require("node:test");

const { BILLING_PLANS } = require("../src/billing/constants");
const {
  buildSmartOverlayPayload,
} = require("../src/components/smartOverlayControls");
const {
  buildModeAwareTicketControlPayload,
  isTicketControlMessage,
} = require("../src/components/ticketAiControls");
const {
  TICKET_OPERATING_MODES,
  getTicketOperatingModePreferences,
  isFullTicketControlEnabled,
  resolveTicketOperatingMode,
} = require("../src/features/ticketOperatingMode");

function optionValues(payload) {
  return payload.components.flatMap((row) =>
    row.toJSON().components.flatMap((component) =>
      (component.options || []).map((option) => option.value)
    )
  );
}

function withoutReset(values) {
  return values.filter((value) => value !== "reset");
}

test("smart overlay is the non-destructive preset and does not force escalation", () => {
  const settings = getTicketOperatingModePreferences(TICKET_OPERATING_MODES.OVERLAY);

  assert.deepEqual(settings, {
    closeTicketEnabled: false,
    renameReviewEnabled: false,
  });
  assert.equal(resolveTicketOperatingMode(settings), TICKET_OPERATING_MODES.OVERLAY);
  assert.equal(isFullTicketControlEnabled(settings), false);
});

test("full mode explicitly opts into lifecycle controls", () => {
  const settings = getTicketOperatingModePreferences(TICKET_OPERATING_MODES.FULL);

  assert.equal(settings.closeTicketEnabled, true);
  assert.equal(settings.renameReviewEnabled, true);
  assert.equal(settings.escalationEnabled, true);
  assert.equal(resolveTicketOperatingMode(settings), TICKET_OPERATING_MODES.FULL);
  assert.equal(isFullTicketControlEnabled(settings), true);
});

test("premium overlay exposes human handoff when escalation is enabled", () => {
  const payload = buildSmartOverlayPayload(true, {
    plan: BILLING_PLANS.PRO,
    settings: {
      ...getTicketOperatingModePreferences(TICKET_OPERATING_MODES.OVERLAY),
      escalationEnabled: true,
    },
  });

  assert.deepEqual(optionValues(payload), ["escalate", "ai_off"]);
  assert.match(payload.content, /won't close, rename, move, or delete/i);
  assert.match(payload.content, /Pixy AI is ON/i);
});

test("expired overlay keeps the staff AI toggle", () => {
  const payload = buildSmartOverlayPayload(true, {
    plan: BILLING_PLANS.EXPIRED,
    settings: {
      ...getTicketOperatingModePreferences(TICKET_OPERATING_MODES.OVERLAY),
      escalationEnabled: true,
    },
  });

  assert.deepEqual(optionValues(payload), ["ai_off"]);
  assert.match(payload.content, /ticket actions are unavailable/i);
});

test("overlay remains overlay and keeps AI toggle when escalation is disabled", () => {
  const settings = {
    closeTicketEnabled: false,
    renameReviewEnabled: false,
    escalationEnabled: false,
  };
  assert.equal(resolveTicketOperatingMode(settings), TICKET_OPERATING_MODES.OVERLAY);

  const payload = buildSmartOverlayPayload(true, {
    plan: BILLING_PLANS.PRO,
    settings,
  });

  assert.deepEqual(optionValues(payload), ["ai_off"]);
});

test("human handoff keeps a resume-AI control and hides duplicate handoff", () => {
  const payload = buildSmartOverlayPayload(false, {
    plan: BILLING_PLANS.PRO,
    settings: {
      ...getTicketOperatingModePreferences(TICKET_OPERATING_MODES.OVERLAY),
      escalationEnabled: true,
    },
    escalated: true,
  });

  assert.deepEqual(optionValues(payload), ["ai_on"]);
  assert.match(payload.content, /Human support requested/i);
  assert.match(payload.content, /Pixy AI is OFF/i);
});

test("full mode includes AI toggle alongside lifecycle actions", () => {
  const payload = buildModeAwareTicketControlPayload(true, {
    plan: BILLING_PLANS.PRO,
    settings: {
      ...getTicketOperatingModePreferences(TICKET_OPERATING_MODES.FULL),
      agentActionsEnabled: true,
    },
  });

  assert.deepEqual(withoutReset(optionValues(payload)), [
    "escalate",
    "rename",
    "close",
    "ai_off",
  ]);
});

test("custom mode shows only enabled ticket actions plus AI toggle", () => {
  const settings = {
    closeTicketEnabled: false,
    renameReviewEnabled: true,
    escalationEnabled: false,
    agentActionsEnabled: true,
  };
  assert.equal(resolveTicketOperatingMode(settings), TICKET_OPERATING_MODES.CUSTOM);

  const payload = buildModeAwareTicketControlPayload(true, {
    plan: BILLING_PLANS.PRO,
    settings,
  });

  assert.deepEqual(withoutReset(optionValues(payload)), ["rename", "ai_off"]);
  assert.match(payload.content, /Custom Ticket Controls/i);
});

test("custom mode with agent actions disabled still keeps AI toggle", () => {
  const payload = buildModeAwareTicketControlPayload(false, {
    plan: BILLING_PLANS.PRO,
    settings: {
      closeTicketEnabled: true,
      renameReviewEnabled: false,
      escalationEnabled: false,
      agentActionsEnabled: false,
    },
  });

  assert.deepEqual(withoutReset(optionValues(payload)), ["ai_on"]);
});

test("legacy handoff message without components is still repairable", () => {
  assert.equal(isTicketControlMessage({
    author: { bot: true },
    components: [],
    content: "🤝 **Pixy handed this ticket to human support.** Automatic AI replies are paused while the support team reviews it.",
  }), true);
});