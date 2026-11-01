# Trade Blotter

Book trades, review them in a blotter, and see the position per symbol derived from the trade
history.

Trade Blotter is a full-stack TypeScript application: a Fastify API over SQLite and a Vue 3
frontend. Every quantity, price, notional and average cost is handled as an exact decimal, from
the JSON request to the database and back.

## Contents

- [Features](#features)
- [Technology](#technology)
- [Screenshots](#screenshots)
- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
- [Database](#database)
- [Running the application](#running-the-application)
- [Build and test](#build-and-test)
- [API](#api)
- [Position accounting](#position-accounting)
- [Architecture](#architecture)
- [Platform support](#platform-support)
- [Known limitations](#known-limitations)
- [Dependency advisories](#dependency-advisories)
- [Further documentation](#further-documentation)

## Features

- **Book trades** with a symbol, a side (Buy or Sell), a quantity, a price and an optional
  execution time. Invalid input is reported field by field, with every problem shown at once.
- **Trade blotter:** every trade, newest execution first, with its notional and three
  timestamps: when it was executed, created and last updated. Times are shown in your time zone
  with their UTC offset; the exact UTC value is in the tooltip.
- **Positions** derived from the trade history: long or short, net quantity and average cost
  per symbol, shown with every digit the server returns.
- **Exact decimals:** values are read from the JSON source text, calculated with `decimal.js`,
  stored as text and written back without passing through a binary floating-point number.
- **Daylight-saving aware time entry:** a skipped local time is refused, and a time that happens
  twice asks which occurrence you mean.
- **Safe persistence:** one SQLite file, migrated automatically at startup or with a command.
  A failed migration stops startup and changes nothing; the application never deletes or
  recreates a database. A trade that would breach the position limit is refused inside the same
  transaction that would store it.
- **Documented API:** OpenAPI 3.1 with Swagger UI, and RFC 9457 problem details for errors.
- **Responsive frontend** with light and dark themes that follow the system setting.

## Technology

| Part | Technology |
| --- | --- |
| Runtime | Node.js 22.23.1 |
| API | TypeScript, Fastify 5, TypeBox schemas, `@fastify/swagger` and Swagger UI |
| Persistence | SQLite through Node's built-in `node:sqlite`, Drizzle ORM and drizzle-kit (`1.0.0-rc.5`) |
| Decimals | `decimal.js` |
| Frontend | Vue 3, Pinia, Vite |
| Tests | Vitest; Vue Test Utils and jsdom for the frontend |
| Quality | ESLint with typescript-eslint and eslint-plugin-vue; strict TypeScript |

There is no database server, Docker image or external service. npm workspaces hold the API
(`server/`) and the frontend (`client/`).

## Screenshots

| Desktop | Phone, light theme |
| --- | --- |
| ![Positions and trades at 1280 px](docs/verification/screenshots/15-positions-1280.png) | ![Positions on a 375 px screen in the light theme](docs/verification/screenshots/13-narrow-positions-light.png) |

| Choosing between two occurrences of a local time | API unavailable |
| --- | --- |
| ![The form asking which occurrence of a repeated local time is meant](docs/verification/screenshots/07-ambiguous-time.png) | ![Alerts while the API is unavailable, with the last data still shown](docs/verification/screenshots/16-api-unavailable.png) |

## Prerequisites

| Tool | Required | Notes |
| --- | --- | --- |
| Node.js 22.23.1 | Yes | The supported and verified version, recorded in `.nvmrc` |
| npm 12.0.1 | Yes | Bundled with Node.js 22.23.1 |
| Git | Yes | To clone the repository |
| A web browser | For the frontend | Any current Chrome, Edge, Firefox or Safari |

Nothing else needs installing: SQLite is built into Node.js, Drizzle is an npm dependency, and no
package compiles native code or runs an install script.

**Node.js 22.23.1 is the only supported version.** The `engines` range is `^22.23.1`: later 22.x
releases are accepted but have not been verified, and other major versions are not supported.
`npm ci` warns `EBADENGINE` on another version, and the server refuses to start if a runtime
feature it needs is missing.

Install it from <https://nodejs.org/dist/v22.23.1/>, or with a version manager that reads
`.nvmrc`: `nvm install` with [nvm](https://github.com/nvm-sh/nvm) or
`fnm install` with [fnm](https://github.com/Schniz/fnm); on Windows,
`nvm install 22.23.1` with [nvm-windows](https://github.com/coreybutler/nvm-windows). Check with:

```bash
node --version   # v22.23.1
npm --version    # 12.0.1
```

## Getting started

```bash
git clone https://github.com/cs973112/trade-blotter-ts.git
cd trade-blotter-ts
npm ci           # installs the exact versions in package-lock.json, for the API and the frontend
npm run verify   # lint, typecheck, build and run every test
```

`npm run verify` exiting with code 0 means the setup works. Run every command in this README from
the repository root.

## Database

The database is a single SQLite file, `server/data/trade-blotter.db` by default (ignored by Git).
The API creates it and applies any pending migration every time it starts, before it accepts
requests. To do this without starting the API:

```bash
npm run db:migrate -w server
```

It prints `Database is up to date: <path>`; running it again changes nothing. If a migration
fails, every pending migration is rolled back, the command prints
`Database migration failed; no migration was applied.` with the reason, and it exits with code 1.

Set `DATABASE_PATH` to use another file; an absolute path is recommended. The
[setup guide](docs/setup.md#database) covers other files, backups, starting afresh and schema
changes.

## Running the application

### Development

In two terminals, from the repository root:

```bash
npm run dev -w server   # the API on http://localhost:5299, restarting on changes
npm run dev -w client   # the frontend on http://localhost:5173
```

Open <http://localhost:5173>. The frontend calls the API through Vite's proxy, so start the API
first; if it is not running, the page says so.

### Production build

```bash
npm run build               # the API to server/dist/, the frontend to client/dist/
npm start -w server         # terminal 1: the compiled API on http://localhost:5299
npm run preview -w client   # terminal 2: the built frontend on http://localhost:4173
```

Stop either with Ctrl+C: the API finishes requests in progress, closes the database and exits.

### Configuration

All settings are optional environment variables; an invalid value stops the API at startup with
a message naming the variable.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `localhost` | Interface the API listens on |
| `PORT` | `5299` | API port; `0` lets the operating system choose |
| `DATABASE_PATH` | `server/data/trade-blotter.db` | SQLite file; `:memory:` is refused |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace` |
| `DOCS_ENABLED` | `true` | `false` disables Swagger UI and the OpenAPI document |
| `SYMBOL_MAX_LENGTH` | `64` | Longest symbol accepted, an integer from 1 to 255 |
| `API_TARGET` | `http://localhost:5299` | Where the frontend servers forward API requests |

There are no secrets and no `.env` files. Examples for each shell, port changes and
troubleshooting are in the [setup guide](docs/setup.md).

## Build and test

| Command | What it does |
| --- | --- |
| `npm run lint` | ESLint over the whole repository |
| `npm run typecheck` | Type-check the API and the frontend without emitting files |
| `npm run build` | Build the API to `server/dist/` and the frontend to `client/dist/` |
| `npm test` | Run every test once (844 API tests and 121 frontend tests) |
| `npm test -w server` | API tests only |
| `npm test -w client` | Frontend tests only |
| `npm run verify` | Lint, typecheck, build and test, in that order |

```bash
npm test -w server -- test/domain              # one folder
npm test -w server -- -t "positions"           # tests whose name matches
npm exec -w server -- vitest                   # watch mode
```

The tests need no running server, browser, network or existing database. They create their own
databases in the operating system's temp folder, use ports chosen by the operating system, and
remove everything afterwards.

## API

With the API running, Swagger UI is at <http://localhost:5299/documentation> and the OpenAPI 3.1
document at <http://localhost:5299/documentation/json>.

| Endpoint | What it does |
| --- | --- |
| `POST /trades` | Book a trade. Returns `201` and the stored trade. |
| `GET /trades` | Every trade, newest `executedAt` first. |
| `GET /positions` | Every open position, sorted by symbol. |

A trade request has `symbol`, `side` (`Buy` or `Sell`, any case), `quantity`, `price`, and
optionally `executedAt`, an RFC 3339 date-time with an offset (the server clock when omitted).
Quantity and price may be JSON numbers or numeric strings: greater than zero, less than 10^15,
with at most 10 decimal places. The server sets `id`, `bookingSequence`, `createdAt` and
`updatedAt`; the same names in a request are ignored.

```bash
curl -i -X POST http://localhost:5299/trades \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"MSFT","side":"Buy","quantity":100,"price":"301.25","executedAt":"2026-01-02T09:30:00-05:00"}'
curl http://localhost:5299/positions
```

In Windows PowerShell, use `curl.exe` with the same arguments, and a backtick instead of `\` at
the end of a line.

A created trade:

```json
{"id":"0b8f4c6e-…","bookingSequence":1,"symbol":"MSFT","side":"Buy","quantity":100,"price":301.25,
 "notional":30125,"executedAt":"2026-01-02T14:30:00.000Z","createdAt":"2026-03-01T12:00:00.000Z",
 "updatedAt":"2026-03-01T12:00:00.000Z"}
```

A position: `{"symbol":"MSFT","netQuantity":100,"averageCost":301.25}`. `netQuantity` is negative
for a short.

Errors are RFC 9457 problem details (`application/problem+json`). An invalid trade names every
invalid field at once:

```json
{"type":"urn:trade-blotter:problem:invalid-trade","title":"Invalid trade","status":400,
 "detail":"Symbol is required.","errors":{"symbol":["Symbol is required."],"price":["Price must be greater than zero."]}}
```

Other statuses: `400` for a body that is not a JSON object or a trade that would exceed the
position limit, `404` for an unknown path, `405` with an `Allow` header for an unsupported method,
`413` for a body over 1 MiB, `415` for a body that is not JSON, and `500` for anything unexpected.
The [API contract](docs/architecture.md#api-contract) has the details.

## Position accounting

Positions are never stored. Each request folds the trades for every symbol, in trade order,
through one pure domain function. A Buy adds to the net quantity and a Sell subtracts from it, so
long and short positions follow the same rules. Each trade falls under exactly one rule:

| Rule | When | Net quantity | Average cost |
| --- | --- | --- | --- |
| Open | The position is flat | The trade's signed quantity | The trade price |
| Increase | Same direction as the position | Grows | Quantity-weighted average of the position and the trade |
| Reduce | Opposite direction, smaller | Shrinks | Unchanged |
| Close | Opposite direction, equal | Zero; the position is omitted | Zero |
| Cross | Opposite direction, larger | Changes sign | The trade price |

- **Trade order** is execution time, then booking order. A trade recorded late for an earlier
  execution time is applied at its execution time. Creation and update times never affect it.
- **Symbols** are trimmed, composed to Unicode NFC and upper-cased, so `brk.b` and ` BRK.B ` are
  the same position. Control and invisible characters are refused.
- **Precision:** notionals and net quantities are exact. Average cost is the only value that can
  need rounding (5/3, for example); it is calculated to 50 significant digits, rounding half to
  even, and reported as calculated.
- **Position limit:** a trade that would take any intermediate position to 10^30 or beyond is
  refused with `400` and never stored.
- Realised profit and loss is out of scope.

The [business rules](docs/architecture.md#business-rules) and the
[numeric policy](docs/architecture.md#numeric-policy) give the full detail.

## Architecture

```
Vue 3 frontend ──HTTP──► Fastify routes ─► application services ─► repository interface
                                                                        ▲
                                         Drizzle repository ────────────┘ ─► SQLite
```

Source dependencies point inward: the domain imports no framework or database code, and the
Drizzle repository implements an interface the application defines.

| Layer | Folder | Responsibility |
| --- | --- | --- |
| Domain | `server/src/domain/` | Trades, validation, symbols, timestamps, positions and the decimal policy, as pure functions |
| Application | `server/src/application/` | Trade and position services; the repository, clock and id interfaces |
| API | `server/src/api/` | Routes, request and response schemas, lossless JSON, problem details, OpenAPI |
| Infrastructure | `server/src/infrastructure/` | Drizzle schema, migrations, the repository, the system clock, the id generator |
| Composition | `server/src/main.ts`, `server/src/server.ts` | Builds everything and passes dependencies in explicitly, without a dependency-injection framework |
| Frontend | `client/src/` | Vue components, one Pinia store, a typed HTTP client |

ESLint rules and a test both fail if a layer imports something it must not. Creating a trade
checks the symbol's position and inserts the trade in one SQLite transaction.

Each trade has three timestamps: `executedAt` (optional in the request; the server clock when
omitted), and `createdAt` and `updatedAt`, which only the server sets. Trades are immutable, so
`updatedAt` equals `createdAt`.

[docs/architecture.md](docs/architecture.md) has diagrams, the database schema, the transaction
boundary, error handling and the test strategy.

## Platform support

- **Verified:** Windows 11 x64 with Node.js 22.23.1 and npm 12.0.1. Installation, lint,
  typecheck, build, all tests, migrations, the compiled API and the built frontend were run from
  a fresh copy of the source.
- **Intended, not verified:** macOS and Linux. The commands are the same, the code builds paths
  with `node:path`, files use LF line endings, and the lockfile includes the native build
  packages for Linux x64 and arm64 (glibc and musl), macOS x64 and arm64, and Windows x64 and
  arm64. None of this has been run on those systems.

## Known limitations

- Verified on Windows 11 x64 only; see [Platform support](#platform-support).
- Node.js 22.23.1 is the only supported runtime.
- Trades cannot be amended or deleted, and there is no audit history.
- Realised profit and loss is not calculated.
- The frontend and API have no authentication; the API listens on `localhost` by default.
- The frontend tests use jsdom; no end-to-end browser tests are included.
- Building the frontend needs the native Vite packages (rolldown and lightningcss) for your
  platform; `npm ci` installs them from the npm registry.

## Dependency advisories

`npm audit` reports 19 moderate advisories, all from two packages:
[GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) in `glob` and
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) in `minimatch`.

- They are reached through development tooling (ESLint, typescript-eslint, Vue Test Utils) and,
  at runtime, through `@fastify/static`, which Swagger UI uses to serve its files.
- Patched releases are new major versions that none of the packages depending on them accepts
  yet, so there is no update within the declared ranges. No `overrides` are used.
- In a local check, the API loaded `glob` at startup but called none of its functions while
  serving Swagger UI, its static files, the OpenAPI document and `GET /positions`. Whether either
  advisory can be exploited in this application has not been assessed.
- Do not run `npm audit fix --force`: it proposes major downgrades that break the build.

## Further documentation

- [Setup guide](docs/setup.md): installation, configuration, database, ports, troubleshooting
- [Architecture](docs/architecture.md): layers, diagrams, business rules, numeric and timestamp
  policies, persistence, API contract, testing
