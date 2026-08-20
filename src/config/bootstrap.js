const { Client, Collection, GatewayIntentBits, REST, Routes } = require("discord.js");
const fs = require("fs");
const path = require("path");
const { loadEnv } = require("./env");
const { runWithGuildContext } = require("../context/guildContext");
const {
  validateCredentialEncryptionKey,
} = require("../security/credentialEncryption");

const SLASH_COMMAND_PREFIX = "pixy-";
const PUBLIC_SLASH_COMMANDS = Object.freeze([
  "setup",
  "settings",
  "billing",
  "help",
  "reset",
]);
const PUBLIC_SLASH_COMMAND_SET = new Set(PUBLIC_SLASH_COMMANDS);
const GUILD_INSTALL_TYPE = 0;
const GUILD_INTERACTION_CONTEXT = 0;

function getAllJsFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath).sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      getAllJsFiles(fullPath, arrayOfFiles);
    } else if (file.endsWith(".js")) {
      arrayOfFiles.push(fullPath);
    }
  }

  return arrayOfFiles;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function getCommandName(command) {
  return command?.data?.name || command?.name || "unknown";
}

function getBaseSlashCommandName(command) {
  const currentName = String(getCommandName(command) || "").toLowerCase();
  if (!currentName || currentName === "unknown") return currentName;
  return currentName.startsWith(SLASH_COMMAND_PREFIX)
    ? currentName.slice(SLASH_COMMAND_PREFIX.length)
    : currentName;
}

function isPublicSlashCommand(command) {
  return PUBLIC_SLASH_COMMAND_SET.has(getBaseSlashCommandName(command));
}

function getProductionSlashCommandName(command) {
  const currentName = String(getCommandName(command) || "").toLowerCase();
  if (!currentName || currentName === "unknown") return currentName;
  return currentName.startsWith(SLASH_COMMAND_PREFIX)
    ? currentName
    : `${SLASH_COMMAND_PREFIX}${currentName}`;
}

function applyProductionSlashCommandName(command) {
  const commandName = getProductionSlashCommandName(command);
  if (!commandName) return commandName;

  if (typeof command.data?.setName === "function") {
    command.data.setName(commandName);
  } else if (command.data && typeof command.data === "object") {
    command.data.name = commandName;
  }

  return commandName;
}

function attachSource(handler, commandName) {
  const attached = { ...handler, sourceCommand: commandName };

  // Slash handlers are registered before standalone component modules load.
  // Delegate execution to the original handler object so a later component can
  // safely refine that handler without leaving the client with a stale copy.
  if (typeof handler?.execute === "function") {
    attached.execute = (...args) => handler.execute.apply(handler, args);
  }

  return attached;
}

function registerInteractionHandlers(client, command) {
  const commandName = getCommandName(command);

  for (const handler of toArray(command.buttonHandlers)) {
    client.buttonHandlers.push(attachSource(handler, commandName));
  }
  for (const handler of toArray(command.buttons)) {
    client.buttonHandlers.push(attachSource(handler, commandName));
  }
  for (const handler of toArray(command.selectMenuHandlers)) {
    client.selectMenuHandlers.push(attachSource(handler, commandName));
  }
  for (const handler of toArray(command.selectMenus)) {
    client.selectMenuHandlers.push(attachSource(handler, commandName));
  }
  for (const handler of toArray(command.modalHandlers)) {
    client.modalHandlers.push(attachSource(handler, commandName));
  }
  for (const handler of toArray(command.modals)) {
    client.modalHandlers.push(attachSource(handler, commandName));
  }

  if (typeof command.autocomplete === "function") {
    client.autocompleteHandlers.push({
      sourceCommand: commandName,
      commandName,
      execute: command.autocomplete,
    });
  }

  for (const handler of toArray(command.autocompleteHandlers)) {
    client.autocompleteHandlers.push(attachSource(handler, commandName));
  }

  for (const handler of toArray(command.componentHandlers)) {
    const type = String(handler.type || "").toLowerCase();
    const prepared = attachSource(handler, commandName);

    if (type === "button" || type === "buttons") {
      client.buttonHandlers.push(prepared);
    } else if (type === "modal" || type === "modals") {
      client.modalHandlers.push(prepared);
    } else if (type === "autocomplete") {
      client.autocompleteHandlers.push(prepared);
    } else {
      client.selectMenuHandlers.push(prepared);
    }
  }
}

function commandToJSON(command, options = {}) {
  const json = typeof command.data?.toJSON === "function"
    ? command.data.toJSON()
    : { ...(command.data || {}) };
  const globalScope = options.globalScope !== false;

  if (command.guildOnly === true && globalScope) {
    return {
      ...json,
      integration_types: [GUILD_INSTALL_TYPE],
      contexts: [GUILD_INTERACTION_CONTEXT],
    };
  }

  return json;
}

async function syncCommands({ token, clientId, guildId }, commands, prefixCount) {
  const rest = new REST({ version: "10" }).setToken(token);
  const globalScope = !guildId;
  const body = commands.map((command) => commandToJSON(command, { globalScope }));

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    console.log(`Synced ${body.length} guild slash command(s) to ${guildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log(`Synced ${body.length} global slash command(s).`);
  }

  console.log(`Public slash commands: ${body.map((command) => command.name).join(", ")}.`);
  console.log(`Loaded ${prefixCount} prefix command(s).`);
}

function getGuildIdFromEventArgs(args) {
  for (const value of args) {
    const guildId = value?.guild?.id || value?.guildId || value?.message?.guild?.id;
    if (guildId) return String(guildId);
  }
  return null;
}

function registerEvent(client, event) {
  const listener = (...args) => {
    const guildId = getGuildIdFromEventArgs(args);
    return runWithGuildContext(guildId, () => event.execute(...args));
  };

  if (event.once || event.name === "ready") {
    client.once(event.name, listener);
  } else {
    client.on(event.name, listener);
  }
}

async function bootstrap() {
  try {
    const env = loadEnv();
    validateCredentialEncryptionKey();

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    client.appEnv = env;
    client.commands = new Collection();
    client.prefixCommands = new Collection();
    client.aliases = new Collection();
    client.buttonHandlers = [];
    client.selectMenuHandlers = [];
    client.modalHandlers = [];
    client.autocompleteHandlers = [];
    client.cooldowns = new Collection();

    const prefixPath = path.join(__dirname, "../prefix");
    if (fs.existsSync(prefixPath)) {
      for (const file of getAllJsFiles(prefixPath)) {
        const command = require(file);
        if (!command?.name || typeof command.execute !== "function") {
          console.warn(`Skipped invalid prefix command: ${file}`);
          continue;
        }

        const commandName = command.name.toLowerCase();
        client.prefixCommands.set(commandName, command);
        for (const alias of toArray(command.aliases)) {
          client.aliases.set(String(alias).toLowerCase(), commandName);
        }
      }
    }

    const commands = [];
    const slashPath = path.join(__dirname, "../slash");
    if (fs.existsSync(slashPath)) {
      for (const file of getAllJsFiles(slashPath)) {
        const command = require(file);
        if (!command?.data || typeof command.execute !== "function") {
          console.warn(`Skipped invalid slash command: ${file}`);
          continue;
        }

        if (!isPublicSlashCommand(command)) {
          console.warn(
            `Skipped non-public slash command ${getCommandName(command)} from ${file}.`
          );
          continue;
        }

        const commandName = applyProductionSlashCommandName(command);
        commands.push(command);
        client.commands.set(commandName, command);
        registerInteractionHandlers(client, command);
      }
    }

    const componentsPath = path.join(__dirname, "../components");
    if (fs.existsSync(componentsPath)) {
      const componentFiles = getAllJsFiles(componentsPath);
      for (const file of componentFiles) {
        registerInteractionHandlers(client, require(file));
      }
      console.log(`Loaded ${componentFiles.length} component module(s).`);
    }

    const eventsPath = path.join(__dirname, "../events");
    if (fs.existsSync(eventsPath)) {
      for (const file of getAllJsFiles(eventsPath)) {
        const event = require(file);
        if (!event?.name || typeof event.execute !== "function") {
          console.warn(`Skipped invalid event: ${file}`);
          continue;
        }
        registerEvent(client, event);
      }
    }

    await syncCommands(env, commands, client.prefixCommands.size);
    await client.login(env.token);
  } catch (error) {
    console.error("Startup failed:", error);
    process.exit(1);
  }
}

module.exports = {
  GUILD_INSTALL_TYPE,
  GUILD_INTERACTION_CONTEXT,
  PUBLIC_SLASH_COMMANDS,
  SLASH_COMMAND_PREFIX,
  applyProductionSlashCommandName,
  attachSource,
  bootstrap,
  commandToJSON,
  getBaseSlashCommandName,
  getProductionSlashCommandName,
  isPublicSlashCommand,
};