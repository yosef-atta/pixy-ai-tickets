const assert = require("node:assert/strict");
const test = require("node:test");

const {
  QUICK_IMPORT_PLACEHOLDER,
  buildQuickImportModal,
  parseQuickImportId,
} = require("../src/components/settingsKnowledgeQuickImport");

test("Quick Import placeholder stays inside Discord's 100-character limit", () => {
  assert.ok(QUICK_IMPORT_PLACEHOLDER.length <= 100);

  const modal = buildQuickImportModal("123456789", 2).toJSON();
  const placeholder = modal.components[0].components[0].placeholder;
  assert.equal(placeholder, QUICK_IMPORT_PLACEHOLDER);
  assert.ok(placeholder.length <= 100);
});

test("Quick Import modal keeps the existing submission field and page context", () => {
  const modal = buildQuickImportModal("123456789", 3).toJSON();
  const input = modal.components[0].components[0];

  assert.equal(input.custom_id, "bulk_qna");
  assert.equal(input.max_length, 4000);
  assert.match(modal.custom_id, /settings_knowledge_quick_import_modal:123456789:3$/);
});

test("Quick Import button ids parse the owner and current page", () => {
  assert.deepEqual(
    parseQuickImportId("settings_knowledge_quick_import:123456789:4"),
    { userId: "123456789", page: 4 }
  );
});
