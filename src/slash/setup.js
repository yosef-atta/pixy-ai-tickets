const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
} = require("discord.js");
const { startTrialOnce } = require("../billing/billingService");
const {
  refreshOpenTicketControlsAfterBillingMutation,
} = require("../billing/ticketControlRefresh");
const { prisma } = require("../config/prisma");
const {
  replaceCategoryTicketSources,
} = require("../config/ticketSources");
const {
  reconcileGuildTicketChannels,
} = require("../tickets/ticketChannelLifecycle");

const EPHEMERAL = 64;
const SELECT_EXISTING = "setup_select_category_existing:";
const CREATE_AUTO = "setup_create_category_auto:";
const CATEGORY_SELECT = "setup_category_select:";
const AUTO_NAMES = ["pixy-tickets", "pixy-support-tickets", "pixy-help-tickets"];

async function assertOwner(interaction, userId) {
  if (!interaction.guild || interaction.user.id !== userId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Only the administrator who opened /pixy-setup can use this control.", flags: EPHEMERAL });
    return false;
  }
  return true;
}

async function currentCategory(guild) {
  const config = await prisma.guildConfig.findUnique({ where: { guildId: guild.id } });
  if (!config?.ticketCategoryId) return null;
  const cached = guild.channels.cache.get(config.ticketCategoryId);
  if (cached?.type === ChannelType.GuildCategory) return cached;
  return guild.channels.fetch(config.ticketCategoryId).catch(() => null);
}

function categoryPayload(userId, category) {
  return {
    content: [
      category ? `Current ticket category: **${category.name}**` : "Ticket category is not configured yet.",
      "",
      "Choose the category where your current ticket system creates ticket channels:",
    ].join("\n"),
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${SELECT_EXISTING}${userId}`).setLabel("Select existing category").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${CREATE_AUTO}${userId}`).setLabel("Create automatically").setStyle(ButtonStyle.Secondary)
    )],
  };
}

function categorySelectPayload(userId) {
  return {
    content: "Choose the category where your ticket system creates ticket channels:",
    components: [new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`${CATEGORY_SELECT}${userId}`)
        .setPlaceholder("Select the ticket category")
        .setChannelTypes(ChannelType.GuildCategory)
    )],
  };
}

async function saveCategory(guildId, categoryId, options = {}) {
  const client = options.client || prisma;
  const config = await client.guildConfig.upsert({
    where: { guildId },
    create: { guildId, ticketCategoryId: categoryId, enabled: true, maxLearnedItems: 50 },
    update: { ticketCategoryId: categoryId, enabled: true },
  });

  if (client.ticketSource?.deleteMany && client.ticketSource?.upsert) {
    await replaceCategoryTicketSources(guildId, [categoryId], { client });
  }

  return config;
}

async function saveCategoryAndStartTrial(guildId, categoryId, options = {}) {
  const client = options.client || prisma;
  const startTrial = options.startTrial || startTrialOnce;
  const refreshControls =
    options.refreshControls || refreshOpenTicketControlsAfterBillingMutation;
  const reconcileTickets = options.reconcileTickets || reconcileGuildTicketChannels;
  const config = await saveCategory(guildId, categoryId, { client });

  await startTrial(guildId, { client });

  if (options.guild) {
    await reconcileTickets(options.guild, {
      client,
      ensureControls: true,
    }).catch((error) => {
      console.error("Failed to reconcile existing tickets after setup:", error);
    });
  }

  if (options.guild || options.discordClient) {
    await refreshControls(guildId, {
      client,
      guild: options.guild,
      discordClient: options.discordClient,
      logger: options.logger,
    }).catch((error) => {
      console.error("Failed to refresh ticket controls after setup billing initialization:", error);
    });
  }

  return config;
}

async function completeExistingCategorySetup(guildId, categoryId, options = {}) {
  return saveCategoryAndStartTrial(guildId, categoryId, options);
}

async function completeAutomaticCategorySetup(guildId, categoryId, options = {}) {
  return saveCategoryAndStartTrial(guildId, categoryId, options);
}

async function createOrFind(guild) {
  await guild.channels.fetch().catch(() => null);
  const existing = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildCategory && AUTO_NAMES.includes(String(channel.name).toLowerCase())
  );
  if (existing) return existing;
  const member = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!member?.permissions.has(PermissionFlagsBits.ManageChannels)) return null;
  return guild.channels.create({ name: AUTO_NAMES[0], type: ChannelType.GuildCategory, reason: "Pixy AI ticket category setup" });
}

const command = {
  data: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Setup the Pixy AI ticket category.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  guildOnly: true,
  userPermissions: [PermissionFlagsBits.Administrator],

  async execute(interaction) {
    const category = await currentCategory(interaction.guild);
    await interaction.reply({ ...categoryPayload(interaction.user.id, category), flags: EPHEMERAL });
  },

  buttonHandlers: [
    {
      customIdPrefix: SELECT_EXISTING,
      async execute(interaction) {
        const userId = interaction.customId.slice(SELECT_EXISTING.length);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.update(categorySelectPayload(userId));
      },
    },
    {
      customIdPrefix: CREATE_AUTO,
      async execute(interaction) {
        const userId = interaction.customId.slice(CREATE_AUTO.length);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.deferUpdate();
        const category = await createOrFind(interaction.guild);
        if (!category) {
          await interaction.editReply({ content: "I need Manage Channels permission to create the ticket category automatically.", components: [] });
          return;
        }
        await completeAutomaticCategorySetup(
          interaction.guild.id,
          category.id,
          {
            guild: interaction.guild,
            discordClient: interaction.client,
          }
        );
        await interaction.editReply({ content: `Ticket category saved as **${category.name}**. Existing tickets in it were reconciled. Configure the Groq key and features with /pixy-settings.`, components: [] });
      },
    },
  ],

  selectMenuHandlers: [
    {
      customIdPrefix: CATEGORY_SELECT,
      type: "channel",
      async execute(interaction) {
        const userId = interaction.customId.slice(CATEGORY_SELECT.length);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.deferUpdate();
        const categoryId = interaction.values?.[0];
        const category = interaction.guild.channels.cache.get(categoryId) || await interaction.guild.channels.fetch(categoryId).catch(() => null);
        if (!category || category.type !== ChannelType.GuildCategory) {
          await interaction.editReply({ content: "Invalid category selected.", components: [] });
          return;
        }
        await completeExistingCategorySetup(
          interaction.guild.id,
          category.id,
          {
            guild: interaction.guild,
            discordClient: interaction.client,
          }
        );
        await interaction.editReply({ content: `Ticket category saved as **${category.name}**. Existing tickets in it were reconciled. Configure the Groq key and features with /pixy-settings.`, components: [] });
      },
    },
  ],
};

module.exports = Object.assign(command, {
  AUTO_NAMES,
  CATEGORY_SELECT,
  CREATE_AUTO,
  SELECT_EXISTING,
  completeAutomaticCategorySetup,
  completeExistingCategorySetup,
  createOrFind,
  saveCategory,
  saveCategoryAndStartTrial,
});