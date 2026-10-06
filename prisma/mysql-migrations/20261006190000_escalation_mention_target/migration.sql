ALTER TABLE `GuildSetting`
  ADD COLUMN `escalationMentionTarget` VARCHAR(32) NOT NULL DEFAULT 'outside';
