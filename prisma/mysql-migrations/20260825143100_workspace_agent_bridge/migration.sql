CREATE TABLE `WorkspaceAgentDelivery` (
  `id` VARCHAR(191) NOT NULL,
  `guildId` VARCHAR(32) NOT NULL,
  `tokenHash` CHAR(64) NOT NULL,
  `triggerRunId` VARCHAR(191) NULL,
  `conversationUrl` TEXT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `replyText` TEXT NULL,
  `error` TEXT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `deliveredAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `WorkspaceAgentDelivery_tokenHash_key`(`tokenHash`),
  INDEX `WorkspaceAgentDelivery_guildId_status_createdAt_idx`(`guildId`, `status`, `createdAt`),
  INDEX `WorkspaceAgentDelivery_expiresAt_idx`(`expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
