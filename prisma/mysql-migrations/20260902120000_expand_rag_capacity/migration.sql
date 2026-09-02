ALTER TABLE `GuildConfig`
  ALTER COLUMN `maxLearnedItems` SET DEFAULT 1000;

ALTER TABLE `GuildConfig`
  ALTER COLUMN `maxAdminRoutes` SET DEFAULT 1000;

UPDATE `GuildConfig`
SET `maxLearnedItems` = 1000
WHERE `maxLearnedItems` IN (20, 50);

UPDATE `GuildConfig`
SET `maxAdminRoutes` = 1000
WHERE `maxAdminRoutes` IN (10, 25);
