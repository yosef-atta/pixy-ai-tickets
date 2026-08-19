const {
  ActionRowBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const settings = require("../slash/settings");
const {
  getGuildLearnedKnowledgeWriteAvailability,
  getSubscriptionRejectionMessage,
} = require("../billing/entitlementService");

const EPHEMERAL = 64;
const { PREFIX } = settings;

const QUICK_IMPORT_PLACEHOLDER = "Q: Gold package price?\nA: $...\n\nس: مدة الباقة؟\nج: ...";

function parseQuickImportId(customId) {
  const parts = String(customId || "")
    .slice(PREFIX.KNOWLEDGE_QUICK_IMPORT.length)
    .split(":");
  return {
    userId: parts[0] || "",
    page: Number(parts[1]) || 0,
  };
}

function buildQuickImportModal(userId, page = 0) {
  const input = new TextInputBuilder()
    .setCustomId("bulk_qna")
    .setLabel("Paste Q&A facts")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000)
    .setPlaceholder(QUICK_IMPORT_PLACEHOLDER);

  return new ModalBuilder()
    .setCustomId(`${PREFIX.KNOWLEDGE_QUICK_IMPORT_MODAL}${userId}:${page}`)
    .setTitle("Quick Import Knowledge")
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function assertOwner(interaction, userId) {
  const allowed =
    interaction.guild &&
    interaction.user.id === userId &&
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  if (allowed) return true;

  await interaction.reply({
    content: "Only the administrator who opened `/pixy-settings` can use this control.",
    flags: EPHEMERAL,
  });
  return false;
}

async function ensureKnowledgeWriteAllowed(interaction) {
  const availability = await getGuildLearnedKnowledgeWriteAvailability(interaction.guild.id);
  if (availability.available === true) return true;

  await interaction.reply({
    content:
      getSubscriptionRejectionMessage(availability.code) ||
      "Adding learned knowledge requires an active Trial, Pro, or Partner plan.",
    flags: EPHEMERAL,
  });
  return false;
}

const quickImportHandler = settings.buttonHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.KNOWLEDGE_QUICK_IMPORT
);

if (!quickImportHandler) {
  throw new Error("Pixy Settings Quick Import handler is missing.");
}

quickImportHandler.execute = async function executeKnowledgeQuickImport(interaction) {
  const { userId, page } = parseQuickImportId(interaction.customId);
  if (!(await assertOwner(interaction, userId))) return;
  if (!(await ensureKnowledgeWriteAllowed(interaction))) return;
  await interaction.showModal(buildQuickImportModal(userId, page));
};

module.exports = {
  QUICK_IMPORT_PLACEHOLDER,
  buildQuickImportModal,
  parseQuickImportId,
};
