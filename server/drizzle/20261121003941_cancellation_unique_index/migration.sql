-- M4: the unique index on original_trade_id holds only the cancellation rows. The rule is unchanged
-- (at most one cancellation row per original trade); the ordinary trades' NULLs, never equal to one
-- another, are no longer indexed. An index, not a table constraint: replaced without a table rebuild,
-- in the migrator's one transaction, so no write can come between the two statements. The old index
-- guaranteed there are no duplicates, so the new one is always created. No row changes.
DROP INDEX `trades_original_trade_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `trades_original_trade_id` ON `trades` (`original_trade_id`) WHERE "trades"."original_trade_id" is not null;
