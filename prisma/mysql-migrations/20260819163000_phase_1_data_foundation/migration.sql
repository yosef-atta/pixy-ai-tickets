ALTER TABLE `GuildSetting`
  MODIFY `closeTicketEnabled` BOOLEAN NOT NULL DEFAULT false,
  MODIFY `renameReviewEnabled` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `TicketSource` (
  `id` VARCHAR(191) NOT NULL,
  `guildId` VARCHAR(32) NOT NULL,
  `type` VARCHAR(32) NOT NULL DEFAULT 'category',
  `sourceId` VARCHAR(32) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `TicketSource_guildId_type_sourceId_key`(`guildId`, `type`, `sourceId`),
  INDEX `TicketSource_guildId_enabled_idx`(`guildId`, `enabled`),
  INDEX `TicketSource_type_sourceId_idx`(`type`, `sourceId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `GuildAiConfig` (
  `id` VARCHAR(191) NOT NULL,
  `guildId` VARCHAR(32) NOT NULL,
  `provider` VARCHAR(32) NOT NULL DEFAULT 'groq',
  `model` VARCHAR(191) NULL,
  `credentialEncrypted` TEXT NULL,
  `credentialType` VARCHAR(64) NOT NULL DEFAULT 'groq-api-key',
  `systemPrompt` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `GuildAiConfig_guildId_key`(`guildId`),
  INDEX `GuildAiConfig_provider_idx`(`provider`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `GuildSetupState` (
  `id` VARCHAR(191) NOT NULL,
  `guildId` VARCHAR(32) NOT NULL,
  `setupVersion` INTEGER NOT NULL DEFAULT 2,
  `lastStep` VARCHAR(32) NOT NULL DEFAULT 'ticket_sources',
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `GuildSetupState_guildId_key`(`guildId`),
  INDEX `GuildSetupState_setupVersion_idx`(`setupVersion`),
  INDEX `GuildSetupState_completedAt_idx`(`completedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TicketSource`
  ADD CONSTRAINT `TicketSource_guildId_fkey`
  FOREIGN KEY (`guildId`) REFERENCES `GuildConfig`(`guildId`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill every legacy single ticket category into the new multi-source table.
INSERT INTO `TicketSource` (
  `id`, `guildId`, `type`, `sourceId`, `enabled`, `createdAt`, `updatedAt`
)
SELECT
  CONCAT('legacy-category-', `guildId`),
  `guildId`,
  'category',
  `ticketCategoryId`,
  true,
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
FROM `GuildConfig`
WHERE `ticketCategoryId` IS NOT NULL
ON DUPLICATE KEY UPDATE
  `enabled` = VALUES(`enabled`),
  `updatedAt` = CURRENT_TIMESTAMP(3);

-- Preserve the existing provider/model/key/system-prompt data without deleting legacy fields yet.
INSERT INTO `GuildAiConfig` (
  `id`, `guildId`, `provider`, `model`, `credentialEncrypted`, `credentialType`, `systemPrompt`, `createdAt`, `updatedAt`
)
SELECT
  CONCAT('legacy-ai-', gc.`guildId`),
  gc.`guildId`,
  COALESCE(NULLIF(gc.`aiProvider`, ''), 'groq'),
  COALESCE(gs.`aiModel`, gc.`aiModel`),
  gs.`groqApiKeyEncrypted`,
  'groq-api-key',
  gc.`aiSystemPrompt`,
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
FROM `GuildConfig` gc
LEFT JOIN `GuildSetting` gs ON gs.`guildId` = gc.`guildId`
ON DUPLICATE KEY UPDATE
  `provider` = VALUES(`provider`),
  `model` = VALUES(`model`),
  `credentialEncrypted` = VALUES(`credentialEncrypted`),
  `credentialType` = VALUES(`credentialType`),
  `systemPrompt` = VALUES(`systemPrompt`),
  `updatedAt` = CURRENT_TIMESTAMP(3);

-- GuildSetting can exist before GuildConfig, so preserve those credentials too.
INSERT INTO `GuildAiConfig` (
  `id`, `guildId`, `provider`, `model`, `credentialEncrypted`, `credentialType`, `systemPrompt`, `createdAt`, `updatedAt`
)
SELECT
  CONCAT('legacy-ai-', gs.`guildId`),
  gs.`guildId`,
  'groq',
  gs.`aiModel`,
  gs.`groqApiKeyEncrypted`,
  'groq-api-key',
  NULL,
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
FROM `GuildSetting` gs
LEFT JOIN `GuildAiConfig` ga ON ga.`guildId` = gs.`guildId`
WHERE ga.`guildId` IS NULL;

-- Existing usable setups are considered migrated to setup version 2.
-- Human-support routing stays optional, so ticket source + AI credential is enough to mark completion.
INSERT INTO `GuildSetupState` (
  `id`, `guildId`, `setupVersion`, `lastStep`, `completedAt`, `createdAt`, `updatedAt`
)
SELECT
  CONCAT('legacy-setup-', gc.`guildId`),
  gc.`guildId`,
  2,
  CASE
    WHEN gc.`ticketCategoryId` IS NULL THEN 'ticket_sources'
    WHEN gs.`groqApiKeyEncrypted` IS NULL THEN 'ai_provider'
    ELSE 'complete'
  END,
  CASE
    WHEN gc.`ticketCategoryId` IS NOT NULL AND gs.`groqApiKeyEncrypted` IS NOT NULL
      THEN CURRENT_TIMESTAMP(3)
    ELSE NULL
  END,
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
FROM `GuildConfig` gc
LEFT JOIN `GuildSetting` gs ON gs.`guildId` = gc.`guildId`
ON DUPLICATE KEY UPDATE
  `setupVersion` = VALUES(`setupVersion`),
  `lastStep` = VALUES(`lastStep`),
  `completedAt` = VALUES(`completedAt`),
  `updatedAt` = CURRENT_TIMESTAMP(3);
