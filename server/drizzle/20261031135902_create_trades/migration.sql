CREATE TABLE `trades` (
	`booking_sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`quantity` text NOT NULL,
	`price` text NOT NULL,
	`executed_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
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
	CONSTRAINT "trades_executed_at" CHECK(typeof("executed_at") = 'text'
    and "executed_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "trades_created_at" CHECK(typeof("created_at") = 'text'
    and "created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
	CONSTRAINT "trades_updated_at" CHECK(typeof("updated_at") = 'text'
    and "updated_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' and "updated_at" >= "created_at")
);
--> statement-breakpoint
CREATE INDEX `trades_trade_order` ON `trades` (`executed_at`,`booking_sequence`);--> statement-breakpoint
CREATE INDEX `trades_symbol_trade_order` ON `trades` (`symbol`,`executed_at`,`booking_sequence`);