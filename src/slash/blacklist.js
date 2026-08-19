const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require("discord.js");
const { prisma } = require("../config/prisma");
const {
  findMatchingSourceForChannel,
  listResolvedTicketSources,
} = require("../config/ticketSources");
const {
  reconcileTicketChannel,
} = require("../tickets/ticketChannelLifecycle");
const { createStringSelectMenus } = require("../utils/selectMenuHelper");

const EPHEMERAL = 64;
const PREFIX = Object.freeze({
  ADD_CHANNEL: "blacklist_add_channel:",
  ADD_REASON_YES: "blacklist_add_reason_yes:",
  ADD_REASON_NO: "blacklist_add_reason_no:",
  ADD_REASON_MODAL: "blacklist_add_reason_modal:",
  REMOVE_CHANNEL: "blacklist_remove_channel:",
});

const scoped = (prefix, ...parts) => `${prefix}${parts.join(":")}`;
const parseScoped = (customId, prefix) => customId.slice(prefix.length).split(":");
const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();

async function assertOwner(interaction, userId) {
  const allowed =
    interaction.guild &&
    interaction.user.id === userId &&
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

  if (allowed) return true;

  await interaction.reply({
    content: "Only the administrator who opened this blacklist panel can use it.",
    flags: EPHEMERAL,
  });
  return false;
}

async function acknowledgeUpdate(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate();
  }
}

async function editPanel(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
    return;
  }
  await interaction.update(payload);
}

async function getConfiguredTicketSources(guildId) {
  return listResolvedTicketSources(guildId, { client: prisma });
}

async function getGuildChannel(guild, channelId) {
  return guild.channels.cache.get(channelId) || guild.channels.fetch(channelId).catch(() => null);
}

function addChannelRow(userId) {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(scoped(PREFIX.ADD_CHANNEL, userId))
    .setPlaceholder("Choose a ticket channel...")
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);

  return new ActionRowBuilder().addComponents(menu);
}

function reasonButtons(userId, channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.ADD_REASON_YES, userId, channelId))
      .setLabel("Yes, add a reason")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.ADD_REASON_NO, userId, channelId))
      .setLabel("No reason")
      .setStyle(ButtonStyle.Secondary)
  );
}

function reasonModal(userId, channelId) {
  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Private admin reason")
    .setPlaceholder("Why should Pixy ignore this channel?")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(300);

  return new ModalBuilder()
    .setCustomId(scoped(PREFIX.ADD_REASON_MODAL, userId, channelId))
    .setTitle("Blacklist channel reason")
    .addComponents(new ActionRowBuilder().addComponents(reason));
}

function formatConfiguredCategoryList(sources) {
  const categoryIds = sources
    .filter((source) => source.type === "category" && source.enabled !== false)
    .map((source) => `<#${source.sourceId}>`);
  return categoryIds.length ? categoryIds.join(", ") : "the configured ticket sources";
}

async function validateAddChannel(guild, channelId, selectedChannel = null) {
  const sources = await getConfiguredTicketSources(guild.id);
  if (!sources.length) {
    return { ok: false, message: "Configure Pixy ticket sources with `/pixy-setup` first." };
  }

  const channel = selectedChannel || (await getGuildChannel(guild, channelId));
  if (!channel || channel.type !== ChannelType.GuildText) {
    return { ok: false, message: "That text channel no longer exists." };
  }

  const source = findMatchingSourceForChannel(channel, sources);
  if (!source) {
    return {
      ok: false,
      message: `That channel is not inside any configured Pixy ticket category. Current sources: ${formatConfiguredCategoryList(sources)}.`,
    };
  }

  return { ok: true, channel, source };
}

async function addBlacklistEntry(guildId, channelId, reason) {
  await prisma.$transaction([
    prisma.guildIgnoredChannel.upsert({
      where: { guildId_channelId: { guildId, channelId } },
      create: { guildId, channelId, reason },
      update: { reason },
    }),
    prisma.ticketChannel.deleteMany({ where: { guildId, channelId } }),
  ]);
}

async function finishAdd(interaction, userId, channelId, reason) {
  if (!(await assertOwner(interaction, userId))) return;
  await acknowledgeUpdate(interaction);

  const validation = await validateAddChannel(interaction.guild, channelId);
  if (!validation.ok) {
    await editPanel(interaction, {
      content: validation.message,
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
    return;
  }

  await addBlacklistEntry(interaction.guild.id, channelId, reason);
  await editPanel(interaction, {
    content: `<#${channelId}> is now excluded. Pixy will not read or reply in it while it remains excluded.`,
    embeds: [],
    components: [],
    allowedMentions: { parse: [] },
  });
}

async function buildRemoveReply(guild, userId) {
  const entries = await prisma.guildIgnoredChannel.findMany({
    where: { guildId: guild.id },
    orderBy: { createdAt: "asc" },
    take: 120,
  });

  if (!entries.length) {
    return { content: "No channels are currently excluded from Pixy AI.", components: [] };
  }

  const options = entries.map((entry) => {
    const channel = guild.channels.cache.get(entry.channelId);
    return {
      label: (channel?.name ? `#${channel.name}` : `Unavailable ${entry.channelId.slice(-6)}`).slice(0, 100),
      value: entry.channelId,
      description: (entry.reason || "No private reason").slice(0, 100),
    };
  });

  const components = createStringSelectMenus({
    customId: scoped(PREFIX.REMOVE_CHANNEL, userId),
    placeholder: "Choose a blacklisted channel...",
    options,
  });

  return {
    content: "Choose a channel to restore to Pixy AI.",
    components,
  };
}

async function removeBlacklistEntry(guild, channelId) {
  const channel = await getGuildChannel(guild, channelId);
  const removed = await prisma.guildIgnoredChannel.deleteMany({
    where: { guildId: guild.id, channelId },
  });

  if (!removed.count || !channel) {
    return { removedCount: removed.count, canReactivate: false };
  }

  const reconciliation = await reconcileTicketChannel(channel).catch(() => null);
  return {
    removedCount: removed.count,
    canReactivate: reconciliation?.tracked === true,
    reconciliation,
  };
}

async function buildListEmbed(guildId) {
  const entries = await prisma.guildIgnoredChannel.findMany({
    where: { guildId },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  const description = entries.length
    ? entries
        .map((entry, index) => `${index + 1}. <#${entry.channelId}>${entry.reason ? ` - ${entry.reason}` : ""}`)
        .join("\n")
        .slice(0, 4096)
    : "No channels are excluded from Pixy AI.";

  return new EmbedBuilder()
    .setTitle("Pixy AI channel blacklist")
    .setColor(0xed4245)
    .setDescription(description)
    .setFooter({ text: `${entries.length} excluded channel${entries.length === 1 ? "" : "s"}` });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("blacklist")
    .setDescription("Manage channels excluded from Pixy AI.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Choose what to do")
        .setRequired(true)
        .addChoices(
          { name: "Add", value: "add" },
          { name: "Remove", value: "remove" },
          { name: "List", value: "list" }
        )
    ),
  guildOnly: true,
  userPermissions: [PermissionFlagsBits.Administrator],

  async execute(interaction) {
    const action = interaction.options.getString("action", true);
    await interaction.deferReply({ flags: EPHEMERAL });

    if (action === "list") {
      await interaction.editReply({
        embeds: [await buildListEmbed(interaction.guild.id)],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (action === "add") {
      const sources = await getConfiguredTicketSources(interaction.guild.id);
      await interaction.editReply({
        content: sources.length
          ? `Choose a text channel inside one of Pixy's configured ticket categories to exclude. Current sources: ${formatConfiguredCategoryList(sources)}.`
          : "Configure Pixy ticket sources with `/pixy-setup` first.",
        components: sources.length ? [addChannelRow(interaction.user.id)] : [],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (action === "remove") {
      await interaction.editReply({
        ...(await buildRemoveReply(interaction.guild, interaction.user.id)),
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.editReply({ content: "Unsupported blacklist action." });
  },

  selectMenuHandlers: [
    {
      customIdPrefix: PREFIX.ADD_CHANNEL,
      type: "channel",
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.ADD_CHANNEL);
        if (!(await assertOwner(interaction, userId))) return;
        await acknowledgeUpdate(interaction);

        const channelId = interaction.values[0];
        const selectedChannel = interaction.channels?.get(channelId) || null;
        const validation = await validateAddChannel(interaction.guild, channelId, selectedChannel);
        if (!validation.ok) {
          await editPanel(interaction, {
            content: validation.message,
            embeds: [],
            components: [addChannelRow(userId)],
            allowedMentions: { parse: [] },
          });
          return;
        }

        const existing = await prisma.guildIgnoredChannel.findUnique({
          where: { guildId_channelId: { guildId: interaction.guild.id, channelId } },
        });
        if (existing) {
          await editPanel(interaction, {
            content: `<#${channelId}> is already excluded. Choose another channel.`,
            embeds: [],
            components: [addChannelRow(userId)],
            allowedMentions: { parse: [] },
          });
          return;
        }

        await editPanel(interaction, {
          content: `Selected <#${channelId}>. Do you want to save a private reason?`,
          embeds: [],
          components: [reasonButtons(userId, channelId)],
          allowedMentions: { parse: [] },
        });
      },
    },
    {
      customIdPrefix: PREFIX.REMOVE_CHANNEL,
      type: "string",
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.REMOVE_CHANNEL);
        if (!(await assertOwner(interaction, userId))) return;
        await acknowledgeUpdate(interaction);

        const channelId = interaction.values[0];
        if (channelId === "reset") {
          await editPanel(interaction, await buildRemoveReply(interaction.guild, userId));
          return;
        }

        const result = await removeBlacklistEntry(interaction.guild, channelId);
        const content = !result.removedCount
          ? "That channel was already removed from the Pixy blacklist."
          : result.canReactivate
            ? `<#${channelId}> is no longer excluded and has been reactivated for Pixy AI.`
            : `The blacklist entry for <#${channelId}> was removed, but the channel was not reactivated because it is missing or is outside the configured Pixy ticket sources.`;

        await editPanel(interaction, {
          content,
          embeds: [],
          components: [],
          allowedMentions: { parse: [] },
        });
      },
    },
  ],

  buttonHandlers: [
    {
      customIdPrefix: PREFIX.ADD_REASON_YES,
      async execute(interaction) {
        const [userId, channelId] = parseScoped(interaction.customId, PREFIX.ADD_REASON_YES);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.showModal(reasonModal(userId, channelId));
      },
    },
    {
      customIdPrefix: PREFIX.ADD_REASON_NO,
      async execute(interaction) {
        const [userId, channelId] = parseScoped(interaction.customId, PREFIX.ADD_REASON_NO);
        await finishAdd(interaction, userId, channelId, null);
      },
    },
  ],

  modalHandlers: [
    {
      customIdPrefix: PREFIX.ADD_REASON_MODAL,
      async execute(interaction) {
        const [userId, channelId] = parseScoped(interaction.customId, PREFIX.ADD_REASON_MODAL);
        const reason = cleanText(interaction.fields.getTextInputValue("reason"));
        await finishAdd(interaction, userId, channelId, reason);
      },
    },
  ],
};