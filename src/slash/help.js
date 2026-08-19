const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");
const { createStringSelectMenus } = require("../utils/selectMenuHelper");

const EPHEMERAL = 64;

const PREFIX = Object.freeze({
  NAV: "help_nav:",
  HOME: "help_home:",
  CLOSE: "help_close:",
});

const PAGES = Object.freeze({
  HOME: "home",
  QUICKSTART: "quickstart",
  SOURCES: "sources",
  AI: "ai",
  BILLING: "billing",
  FEATURES: "features",
  COMMANDS: "commands",
  TROUBLESHOOTING: "troubleshooting",
});

const TOPICS = Object.freeze([
  {
    label: "Quick Start",
    description: "Complete the new setup flow from Ticket Sources to Trial",
    value: PAGES.QUICKSTART,
    emoji: "🚀",
  },
  {
    label: "Ticket Sources & Threads",
    description: "Categories, Thread Parents, and thread safety behavior",
    value: PAGES.SOURCES,
    emoji: "🧵",
  },
  {
    label: "AI Provider",
    description: "Choose Groq, Google Gemini, or Mistral and connect an API key",
    value: PAGES.AI,
    emoji: "🤖",
  },
  {
    label: "Plans & Billing",
    description: "Trial, Pro, Partner, Expired, and manual activation",
    value: PAGES.BILLING,
    emoji: "💳",
  },
  {
    label: "Features & Safety",
    description: "Behavior, reusable knowledge, safety, and excluded tickets",
    value: PAGES.FEATURES,
    emoji: "🛡️",
  },
  {
    label: "Commands",
    description: "See the small public Pixy command surface",
    value: PAGES.COMMANDS,
    emoji: "⌨️",
  },
  {
    label: "Troubleshooting",
    description: "Fix setup, provider, Thread, plan, and permission issues",
    value: PAGES.TROUBLESHOOTING,
    emoji: "🛠️",
  },
]);

const scoped = (prefix, userId) => `${prefix}${userId}`;

async function assertOwner(interaction, userId) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "This help panel can only be used inside a server.",
      flags: EPHEMERAL,
    });
    return false;
  }

  if (interaction.user.id !== userId) {
    await interaction.reply({
      content: "Only the person who opened `/pixy-help` can use this panel.",
      flags: EPHEMERAL,
    });
    return false;
  }

  return true;
}

function topicMenu(userId) {
  return createStringSelectMenus({
    customId: scoped(PREFIX.NAV, userId),
    placeholder: "Choose a help topic...",
    includeReset: false,
    options: TOPICS,
  });
}

function navigation(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.HOME, userId))
      .setLabel("Home")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.CLOSE, userId))
      .setLabel("Close")
      .setStyle(ButtonStyle.Secondary)
  );
}

function panel(embed, userId, extraRows = []) {
  return {
    content: null,
    embeds: [embed],
    components: [...topicMenu(userId), ...extraRows, navigation(userId)],
    allowedMentions: { parse: [] },
  };
}

function home(userId) {
  const embed = new EmbedBuilder()
    .setTitle("🤖 Pixy Help")
    .setColor(0x5865f2)
    .setDescription([
      "Pixy works alongside your existing Discord ticket system and can support both channel-based tickets and ticket threads.",
      "",
      "New servers should start with `/pixy-setup`. After onboarding, use `/pixy-settings` for behavior, knowledge, safety, and exclusions.",
    ].join("\n"))
    .addFields({
      name: "Recommended flow",
      value: "`/pixy-setup` → test a ticket → `/pixy-settings` → `/pixy-billing`",
    });
  return panel(embed, userId);
}

function quickStart(userId) {
  const embed = new EmbedBuilder()
    .setTitle("🚀 Quick Start")
    .setColor(0x57f287)
    .setDescription("The first `/pixy-setup` is a guided three-step onboarding flow.")
    .addFields(
      {
        name: "1. Ticket Sources",
        value: [
          "Add every place where your ticket system creates tickets.",
          "Use **Categories** for normal ticket channels and **Thread Parents** for tickets created as threads.",
          "You can configure multiple sources of both types before continuing.",
        ].join("\n"),
      },
      {
        name: "2. AI Provider",
        value: [
          "Choose **Groq**, **Google Gemini**, or **Mistral**.",
          "Add that server's provider API key in `/pixy-setup`; Pixy validates it, encrypts it, and never displays the stored secret again.",
          "The provider default model works immediately, or you can verify and choose another model before pressing Next.",
        ].join("\n"),
      },
      {
        name: "3. Human Support",
        value: "Configure an escalation category and at least one support role route, or choose **Skip for Now**. Human Support is recommended but optional.",
      },
      {
        name: "When the Trial starts",
        value: "The one-time seven-day Trial starts only when onboarding is successfully completed, not when the first Ticket Source is selected.",
      },
      {
        name: "After setup",
        value: "Re-running `/pixy-setup` opens the editable Setup Dashboard. Use `/pixy-settings` for secondary behavior and server content.",
      }
    );
  return panel(embed, userId);
}

function sources(userId) {
  const embed = new EmbedBuilder()
    .setTitle("🧵 Ticket Sources & Threads")
    .setColor(0x5865f2)
    .setDescription("Ticket Sources tell Pixy exactly where ticket conversations may exist.")
    .addFields(
      {
        name: "Category source",
        value: "Tracks normal text ticket channels created directly inside that Discord category.",
      },
      {
        name: "Thread Parent source",
        value: "Tracks ticket threads created directly under a configured text, announcement, forum, or media channel.",
      },
      {
        name: "Thread lifecycle safety",
        value: "Thread tickets always use **Smart Overlay**. Pixy can reply, pause/resume AI, and hand off to Human Support, but it will not close, rename, move, or delete the thread even if channel tickets use Full Ticket Control.",
      },
      {
        name: "Private Threads",
        value: "Pixy must be able to access the private thread. Prefer having the ticket system add Pixy to the thread instead of granting broad Manage Threads permission.",
      },
      {
        name: "Excluded Tickets",
        value: "Open `/pixy-settings` → **Excluded Tickets** to make Pixy ignore a specific tracked channel or thread without removing the whole Ticket Source.",
      }
    );
  return panel(embed, userId);
}

function ai(userId) {
  const embed = new EmbedBuilder()
    .setTitle("🤖 AI Provider")
    .setColor(0xfee75c)
    .setDescription("Pixy currently supports three selectable providers: Groq, Google Gemini, and Mistral.")
    .addFields(
      {
        name: "Choose a provider",
        value: "Run `/pixy-setup` → **AI Provider** and select **Groq**, **Google Gemini**, or **Mistral**. Switching providers clears the previous provider credential and model override so credentials cannot be reused across providers by mistake.",
      },
      {
        name: "Credential storage",
        value: "Add the selected provider's guild-owned API key in the private modal. Pixy validates it before saving it encrypted, and the stored secret is never displayed back to users.",
      },
      {
        name: "Model selection",
        value: "Each provider has a default model. **Change Model** verifies a model against the connected provider account before saving the override.",
      },
      {
        name: "Usage",
        value: "The guild supplies its own provider credential and is responsible for that provider's usage limits and charges. Pixy does not provide a shared provider quota.",
      }
    );
  return panel(embed, userId);
}

function billing(userId) {
  const embed = new EmbedBuilder()
    .setTitle("💳 Plans & Billing")
    .setColor(0x5865f2)
    .setDescription("Billing is manual. Pixy never collects payment credentials or activates a server automatically.")
    .addFields(
      {
        name: "Trial",
        value: "One seven-day premium Trial starts after the first completed onboarding. Resetting configuration or reinviting Pixy does not grant another Trial.",
      },
      {
        name: "Pro",
        value: "Adds learned AI context, new knowledge additions, and validated ticket agent actions for the active subscription period.",
      },
      {
        name: "Partner",
        value: "Provides premium entitlement without an expiry while preserving any stored Pro or Trial dates underneath as fallback state.",
      },
      {
        name: "Expired",
        value: "Generic AI replies and ticket AI On/Off remain available. Learned AI context, new knowledge additions, and agent ticket actions are locked.",
      },
      {
        name: "View or activate",
        value: "Run `/pixy-billing`. Payment options only provide manual contact instructions for the configured owner; never send passwords, tokens, API keys, or backup codes.",
      }
    );
  return panel(embed, userId);
}

function features(userId) {
  const embed = new EmbedBuilder()
    .setTitle("🛡️ Features & Safety")
    .setColor(0x5865f2)
    .setDescription("Secondary behavior and server content live in `/pixy-settings`.")
    .addFields(
      {
        name: "Ticket Behavior",
        value: "Choose Smart Overlay or Full Ticket Control and manage AI Replies, Close, Rename, Human Escalation, and Agent Actions. Full Control must pass permission/setup preflight.",
      },
      {
        name: "Knowledge",
        value: "Knowledge is reusable AI context, **not exact FAQ matching**. A Q&A item gives Pixy an example question plus the fact behind it, so differently worded questions can still use that information. For packages, pricing, policies, or longer topics, one Free-form note can cover many related questions. **Quick Import** can add several Q&A facts at once.",
      },
      {
        name: "Safety",
        value: "Manage server-specific blocked terms and intentional allow exceptions for false positives.",
      },
      {
        name: "Excluded Tickets",
        value: "Exclude individual tracked channels or threads from Pixy, optionally with a private admin reason, then restore them later.",
      },
      {
        name: "Execution safety",
        value: "Plans, feature gates, thread lifecycle restrictions, and ticket state are rechecked when an action executes, so stale Discord components cannot bypass current rules.",
      }
    );
  return panel(embed, userId);
}

function commands(userId) {
  const embed = new EmbedBuilder()
    .setTitle("⌨️ Pixy Commands")
    .setColor(0x5865f2)
    .setDescription("Pixy's public command surface is intentionally small.")
    .addFields(
      {
        name: "/pixy-setup",
        value: "First-run onboarding, then the Setup Dashboard for Ticket Sources, AI Provider, and Human Support.",
      },
      {
        name: "/pixy-settings",
        value: "Ticket Behavior, Knowledge, Safety, and Excluded Tickets.",
      },
      {
        name: "/pixy-billing",
        value: "Plan status, remaining time, capability availability, and manual activation/renewal instructions.",
      },
      {
        name: "/pixy-help",
        value: "Open this help center.",
      },
      {
        name: "/pixy-reset",
        value: "Administrator-only destructive reset of Pixy operational data. Billing continuity and audit records are retained.",
      }
    );
  return panel(embed, userId);
}

function troubleshooting(userId) {
  const embed = new EmbedBuilder()
    .setTitle("🛠️ Troubleshooting")
    .setColor(0xed4245)
    .setDescription("Check the section matching the problem you are seeing.")
    .addFields(
      {
        name: "Pixy is not replying in a channel ticket",
        value: [
          "• Open `/pixy-setup` and confirm the channel's parent Category is an active Ticket Source.",
          "• Confirm the AI Provider credential is configured and valid.",
          "• Open `/pixy-settings` and confirm AI Replies are enabled.",
          "• Confirm Pixy can View Channel, Send Messages, and Read Message History.",
        ].join("\n"),
      },
      {
        name: "Pixy is not replying in a thread ticket",
        value: [
          "• Confirm the thread's direct parent is configured as a **Thread Parent** Ticket Source.",
          "• Confirm Pixy can View Channel, Send Messages in Threads, and Read Message History on the parent.",
          "• For a Private Thread, make sure Pixy has access to that specific thread.",
        ].join("\n"),
      },
      {
        name: "Close or Rename is missing inside a thread",
        value: "That is intentional. Thread tickets always use Smart Overlay and never expose Pixy lifecycle actions that close, rename, move, or delete the thread.",
      },
      {
        name: "Full Ticket Control will not enable",
        value: "Pixy runs a preflight first. Fix the exact Ticket Source, Human Support, role, or Discord permission issues shown by `/pixy-settings`, then try again.",
      },
      {
        name: "A learned addition or agent action is locked",
        value: "Run `/pixy-billing`. Expired mode keeps generic AI replies but blocks learned context/additions and premium agent actions.",
      },
      {
        name: "Provider credential or model fails validation",
        value: "Open `/pixy-setup` → **AI Provider**, confirm the correct provider is selected, replace its credential if needed, then use the default model or verify another model available to that account.",
      }
    );
  return panel(embed, userId);
}

function render(page, userId) {
  if (page === PAGES.QUICKSTART) return quickStart(userId);
  if (page === PAGES.SOURCES) return sources(userId);
  if (page === PAGES.AI) return ai(userId);
  if (page === PAGES.BILLING) return billing(userId);
  if (page === PAGES.FEATURES) return features(userId);
  if (page === PAGES.COMMANDS) return commands(userId);
  if (page === PAGES.TROUBLESHOOTING) return troubleshooting(userId);
  return home(userId);
}

const command = {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Learn how to set up and use Pixy."),
  guildOnly: true,
  cooldown: 2,

  async execute(interaction) {
    await interaction.reply({
      ...render(PAGES.HOME, interaction.user.id),
      flags: EPHEMERAL,
    });
  },

  selectMenuHandlers: [
    {
      customIdPrefix: PREFIX.NAV,
      type: "string",
      async execute(interaction) {
        const userId = interaction.customId.slice(PREFIX.NAV.length).split(":")[0];
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.deferUpdate();
        const selected = interaction.values[0];
        await interaction.editReply(render(selected || PAGES.HOME, userId));
      },
    },
  ],

  buttonHandlers: [
    {
      customIdPrefix: PREFIX.HOME,
      async execute(interaction) {
        const userId = interaction.customId.slice(PREFIX.HOME.length);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.deferUpdate();
        await interaction.editReply(render(PAGES.HOME, userId));
      },
    },
    {
      customIdPrefix: PREFIX.CLOSE,
      async execute(interaction) {
        const userId = interaction.customId.slice(PREFIX.CLOSE.length);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.deferUpdate();
        await interaction.editReply({
          content: "Help panel closed.",
          embeds: [],
          components: [],
          allowedMentions: { parse: [] },
        });
      },
    },
  ],
};

module.exports = Object.assign(command, {
  PAGES,
  PREFIX,
  TOPICS,
  ai,
  billing,
  commands,
  features,
  home,
  quickStart,
  render,
  sources,
  troubleshooting,
});
