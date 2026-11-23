-- Trade lifecycle and audit (M3). Hand-written: drizzle-kit's generated rebuild would add NOT NULL
-- columns to a populated table without values, and lose the AUTOINCREMENT high-water mark.
-- Applied by the application's migrator inside its one transaction, so it all applies or none of it.
--
-- 1. Keep the booking-sequence high-water mark, which a rebuild would otherwise lower to the
--    highest sequence still present.
CREATE TABLE `__trades_sequence` AS SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'trades';
--> statement-breakpoint
-- 2. The new table: executed_at nullable, the lifecycle columns, their constraints.
CREATE TABLE `__new_trades` (
	`booking_sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`quantity` text NOT NULL,
	`price` text NOT NULL,
	`executed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`quantity_key` text GENERATED ALWAYS AS (printf('%010d', case when instr("quantity", '.') = 0 then length("quantity") else instr("quantity", '.') - 1 end) || "quantity") VIRTUAL,
	`price_key` text GENERATED ALWAYS AS (printf('%010d', case when instr("price", '.') = 0 then length("price") else instr("price", '.') - 1 end) || "price") VIRTUAL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`original_trade_id` text,
	`cancellation_reason` text,
	CONSTRAINT `fk_trades_original_trade_id_trades_id_fk` FOREIGN KEY (`original_trade_id`) REFERENCES `trades`(`id`),
	CONSTRAINT "trades_id" CHECK(typeof("id") = 'text' and length("id") > 0),
	CONSTRAINT "trades_symbol" CHECK(typeof("symbol") = 'text'
      and length("symbol") between 1 and 255
      and "symbol" = trim("symbol")),
	CONSTRAINT "trades_side" CHECK("side" in ('Buy', 'Sell')),
	CONSTRAINT "trades_quantity" CHECK(typeof("quantity") = 'text'
    and ("quantity" glob '[0-9]' or "quantity" glob '[0-9]*[0-9]')
    and "quantity" not glob '*[^0-9.]*'
    and "quantity" not glob '*.*.*'
    and "quantity" not glob '0[0-9]*'
    and not ("quantity" glob '*.*' and "quantity" glob '*0')
    and "quantity" <> '0'),
	CONSTRAINT "trades_price" CHECK(typeof("price") = 'text'
    and ("price" glob '[0-9]' or "price" glob '[0-9]*[0-9]')
    and "price" not glob '*[^0-9.]*'
    and "price" not glob '*.*.*'
    and "price" not glob '0[0-9]*'
    and not ("price" glob '*.*' and "price" glob '*0')
    and "price" <> '0'),
	CONSTRAINT "trades_executed_at" CHECK(("status" = 'Executed' and typeof("executed_at") = 'text'
    and "executed_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
      or ("status" <> 'Executed' and "executed_at" is null)),
	CONSTRAINT "trades_status" CHECK(typeof("status") = 'text' and "status" in ('Pending', 'Executed', 'Cancelled')),
	CONSTRAINT "trades_actors" CHECK("created_by" in ('User', 'Admin') and "updated_by" in ('User', 'Admin')),
	CONSTRAINT "trades_cancellation" CHECK(("original_trade_id" is null and "cancellation_reason" is null and "created_by" = 'User')
      or (typeof("original_trade_id") = 'text' and "original_trade_id" <> "id" and "status" = 'Cancelled'
        and typeof("cancellation_reason") = 'text' and length(trim("cancellation_reason")) > 0
        and length("cancellation_reason") <= 500
        and "created_by" = 'Admin' and "updated_by" = 'Admin' and "created_at" = "updated_at")),
	CONSTRAINT "trades_created_at" CHECK(typeof("created_at") = 'text'
    and "created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "trades_updated_at" CHECK(typeof("updated_at") = 'text'
    and "updated_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' and "updated_at" >= "created_at")
);;
--> statement-breakpoint
-- 3. Every existing trade, unchanged, as an Executed trade booked and last changed by User. Ids
--    and booking sequences are copied as they are.
INSERT INTO `__new_trades`(`booking_sequence`, `id`, `symbol`, `side`, `quantity`, `price`, `executed_at`, `created_at`, `updated_at`, `status`, `created_by`, `updated_by`, `original_trade_id`, `cancellation_reason`)
  SELECT `booking_sequence`, `id`, `symbol`, `side`, `quantity`, `price`, `executed_at`, `created_at`, `updated_at`, 'Executed', 'User', 'User', NULL, NULL FROM `trades` ORDER BY `booking_sequence`;
--> statement-breakpoint
DROP TABLE `trades`;
--> statement-breakpoint
ALTER TABLE `__new_trades` RENAME TO `trades`;
--> statement-breakpoint
-- 4. The high-water mark back: never lower than before.
UPDATE `sqlite_sequence` SET `seq` = max(`seq`, (SELECT `seq` FROM `__trades_sequence`)) WHERE `name` = 'trades' AND EXISTS (SELECT 1 FROM `__trades_sequence`);
--> statement-breakpoint
INSERT INTO `sqlite_sequence` (`name`, `seq`) SELECT 'trades', `seq` FROM `__trades_sequence` WHERE NOT EXISTS (SELECT 1 FROM `sqlite_sequence` WHERE `name` = 'trades');
--> statement-breakpoint
DROP TABLE `__trades_sequence`;
--> statement-breakpoint
-- 5. The indexes, as before, and one cancellation row per original.
CREATE INDEX `trades_trade_order` ON `trades` (`executed_at`,`booking_sequence`);
--> statement-breakpoint
CREATE INDEX `trades_symbol_trade_order` ON `trades` (`symbol`,`executed_at`,`booking_sequence`);
--> statement-breakpoint
CREATE INDEX `trades_quantity_order` ON `trades` (`quantity_key`,`executed_at`,`booking_sequence`);
--> statement-breakpoint
CREATE INDEX `trades_price_order` ON `trades` (`price_key`,`executed_at`,`booking_sequence`);
--> statement-breakpoint
CREATE UNIQUE INDEX `trades_original_trade_id` ON `trades` (`original_trade_id`);
--> statement-breakpoint
-- 6. The audit table, empty: no history is invented for the rows copied above.
CREATE TABLE `trade_audit` (
	`audit_id` integer PRIMARY KEY AUTOINCREMENT,
	`audit_action` text NOT NULL,
	`audit_on` text NOT NULL,
	`audit_by` text NOT NULL,
	`booking_sequence` integer NOT NULL,
	`id` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`quantity` text NOT NULL,
	`price` text NOT NULL,
	`executed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`quantity_key` text NOT NULL,
	`price_key` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`original_trade_id` text,
	`cancellation_reason` text,
	CONSTRAINT "trade_audit_action" CHECK("audit_action" in ('Inserted', 'Updated', 'Deleted')),
	CONSTRAINT "trade_audit_on" CHECK(typeof("audit_on") = 'text'
    and "audit_on" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "trade_audit_by" CHECK("audit_by" = 'System')
);;
--> statement-breakpoint
CREATE INDEX `trade_audit_trade` ON `trade_audit` (`id`,`audit_id`);
--> statement-breakpoint
-- 7. The triggers, last, after the copy, so the migration itself writes no audit entry. Each entry
--    is a snapshot of every column of trades at that write, the generated sort keys as the values
--    they had then, with SQLite's own clock in canonical UTC.
CREATE TRIGGER `trades_audit_insert` AFTER INSERT ON `trades` BEGIN
  INSERT INTO `trade_audit` (`audit_action`, `audit_on`, `audit_by`, `booking_sequence`, `id`, `symbol`, `side`, `quantity`, `price`, `executed_at`, `created_at`, `updated_at`, `quantity_key`, `price_key`, `status`, `created_by`, `updated_by`, `original_trade_id`, `cancellation_reason`)
  VALUES ('Inserted', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'System', NEW.booking_sequence, NEW.id, NEW.symbol, NEW.side, NEW.quantity, NEW.price, NEW.executed_at, NEW.created_at, NEW.updated_at, NEW.quantity_key, NEW.price_key, NEW.status, NEW.created_by, NEW.updated_by, NEW.original_trade_id, NEW.cancellation_reason);
END;
--> statement-breakpoint
CREATE TRIGGER `trades_audit_update` AFTER UPDATE ON `trades` BEGIN
  INSERT INTO `trade_audit` (`audit_action`, `audit_on`, `audit_by`, `booking_sequence`, `id`, `symbol`, `side`, `quantity`, `price`, `executed_at`, `created_at`, `updated_at`, `quantity_key`, `price_key`, `status`, `created_by`, `updated_by`, `original_trade_id`, `cancellation_reason`)
  VALUES ('Updated', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'System', NEW.booking_sequence, NEW.id, NEW.symbol, NEW.side, NEW.quantity, NEW.price, NEW.executed_at, NEW.created_at, NEW.updated_at, NEW.quantity_key, NEW.price_key, NEW.status, NEW.created_by, NEW.updated_by, NEW.original_trade_id, NEW.cancellation_reason);
END;
--> statement-breakpoint
CREATE TRIGGER `trades_audit_delete` BEFORE DELETE ON `trades` BEGIN
  INSERT INTO `trade_audit` (`audit_action`, `audit_on`, `audit_by`, `booking_sequence`, `id`, `symbol`, `side`, `quantity`, `price`, `executed_at`, `created_at`, `updated_at`, `quantity_key`, `price_key`, `status`, `created_by`, `updated_by`, `original_trade_id`, `cancellation_reason`)
  VALUES ('Deleted', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'System', OLD.booking_sequence, OLD.id, OLD.symbol, OLD.side, OLD.quantity, OLD.price, OLD.executed_at, OLD.created_at, OLD.updated_at, OLD.quantity_key, OLD.price_key, OLD.status, OLD.created_by, OLD.updated_by, OLD.original_trade_id, OLD.cancellation_reason);
END;
--> statement-breakpoint
-- 8. Append-only: an audit entry is never changed or removed.
CREATE TRIGGER `trade_audit_no_update` BEFORE UPDATE ON `trade_audit` BEGIN
  SELECT RAISE(ABORT, 'trade_audit is append-only: an entry cannot be changed');
END;
--> statement-breakpoint
CREATE TRIGGER `trade_audit_no_delete` BEFORE DELETE ON `trade_audit` BEGIN
  SELECT RAISE(ABORT, 'trade_audit is append-only: an entry cannot be removed');
END;