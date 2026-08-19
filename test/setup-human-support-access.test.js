const assert = require("node:assert/strict");
const test = require("node:test");

const {
  humanSupportFailureNotice,
  prepareHumanSupportResourcesBestEffort,
} = require("../src/components/setupHumanSupportAccess");

test("Human Support saves the selected category before a best-effort overwrite failure", async () => {
  const calls = [];
  const category = { id: "category-private", name: "staff-only" };
  const missingAccess = Object.assign(new Error("Missing Access"), { code: 50001 });

  const result = await prepareHumanSupportResourcesBestEffort(
    { id: "guild-1" },
    category,
    {
      async configureEscalationCategory(_guild, categoryId) {
        calls.push(["configure", categoryId]);
        return {
          categoryId,
          notification: {
            ok: false,
            code: "notification_channel_create_failed",
          },
        };
      },
      async prepareHumanSupportCategoryAccess(_guild, selected) {
        calls.push(["access", selected.id]);
        return {
          ok: false,
          code: "permission_overwrite_failed",
          error: missingAccess,
        };
      },
      async prepareHumanSupportNotificationAccess() {
        throw new Error("notification access should not run after category access failed");
      },
    }
  );

  assert.deepEqual(calls, [
    ["configure", "category-private"],
    ["access", "category-private"],
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.categorySaved, true);
  assert.equal(result.categoryAccess.error.code, 50001);
});

test("Human Support retries notification provisioning after category access is prepared", async () => {
  const calls = [];
  let configureCount = 0;
  const category = { id: "category-1", name: "escalated" };

  const result = await prepareHumanSupportResourcesBestEffort(
    { id: "guild-1" },
    category,
    {
      async configureEscalationCategory() {
        configureCount += 1;
        calls.push(`configure-${configureCount}`);
        return {
          categoryId: category.id,
          notification: configureCount === 1
            ? { ok: false, code: "notification_channel_create_failed" }
            : { ok: true, channel: { id: "notification-1" } },
        };
      },
      async prepareHumanSupportCategoryAccess() {
        calls.push("prepare-category");
        return { ok: true, member: { id: "bot-member" } };
      },
      async prepareHumanSupportNotificationAccess() {
        throw new Error("notification overwrite should not be needed after the retry succeeds");
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.categorySaved, true);
  assert.deepEqual(calls, ["configure-1", "prepare-category", "configure-2"]);
});

test("Human Support inaccessible-category copy explains the real 6/6 vs category-overwrite distinction", () => {
  const notice = humanSupportFailureNotice(
    { id: "category-private", name: "staff-only" },
    {
      categoryAccess: {
        ok: false,
        code: "permission_overwrite_failed",
      },
    }
  );

  assert.match(notice, /6\/6 server permission check passed/i);
  assert.match(notice, /category has its own permission overrides/i);
  assert.match(notice, /Create Automatically|Use Auto Category/i);
  assert.match(notice, /View Channel/i);
  assert.match(notice, /Manage Channels/i);
  assert.match(notice, /Manage Roles/i);
});
