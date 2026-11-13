# Setup guide

How to install, configure, verify and run Trade Blotter from a clone of the repository. The
[README](../README.md) has the short version.

- **Verified:** every command here was run on Windows 11 x64 with Node.js 22.23.1 and npm 12.0.1.
- **Partly run under WSL Linux, not on macOS or in a Linux sandbox:** see
  [Platform limitations](#platform-limitations).

Run every command from the repository root (the folder that contains `package.json`), unless a
step says otherwise. Any location on disk works.

## Contents

1. [Prerequisites](#prerequisites)
2. [Getting the source and installing dependencies](#getting-the-source-and-installing-dependencies)
3. [Build and verification](#build-and-verification)
4. [Configuration](#configuration)
5. [Database](#database)
6. [Starting the API](#starting-the-api)
7. [Starting the frontend](#starting-the-frontend)
8. [Ports and running alongside other services](#ports-and-running-alongside-other-services)
9. [Reviewer workflow](#reviewer-workflow)
10. [Troubleshooting](#troubleshooting)
11. [Platform limitations](#platform-limitations)

## Prerequisites

| Requirement | Detail |
| --- | --- |
| Node.js 22.23.1 | The only supported and verified version (`.nvmrc`). `engines` is `^22.23.1`: later 22.x releases are accepted but not verified; other major versions are not supported. |
| npm 12.0.1 | Bundled with Node.js 22.23.1. |
| Git | To clone the repository. |
| Network access to the npm registry | `npm ci` downloads 300 packages, or see [Installing without internet access](#installing-without-internet-access). |
| A writable temp folder | The tests create temporary databases in the operating system's temp folder. |
| A web browser | To use the frontend. `npm run check:ui` and reviewer steps 05 and 06 also need a Chromium-based browser (Chrome, Edge or Chromium, or Chrome for Testing); it is found automatically, see [Finding a browser](../README.md#finding-a-browser). `npm test` and `verify` start none. |
| Compiler, Python, Docker, a database server | Not needed. SQLite is built into Node.js (`node:sqlite`). |

Install Node.js 22.23.1 exactly; installers that pick "the latest LTS" may give another version.

- **Windows:** `node-v22.23.1-x64.msi` from <https://nodejs.org/dist/v22.23.1/>, or
  [nvm-windows](https://github.com/coreybutler/nvm-windows): `nvm install 22.23.1`, then
  `nvm use 22.23.1`. Open a new terminal afterwards.
- **macOS:** `node-v22.23.1.pkg` from the same page, or [nvm](https://github.com/nvm-sh/nvm) or
  [fnm](https://github.com/Schniz/fnm): `nvm install` or `fnm install` in the repository root
  (both read `.nvmrc`).
- **Linux:** nvm or fnm as for macOS, or the official archive for your platform from the same
  page. Distribution packages rarely carry this exact version.

Check the environment; none of these needs the network:

```bash
node --version             # expect v22.23.1
npm --version              # expect 12.0.1
node -p "process.platform + ' ' + process.arch"
node -p "require('node:os').tmpdir()"
node -e "require('node:sqlite'); console.log('node:sqlite available')"
```

## Getting the source and installing dependencies

```bash
git clone https://github.com/cs973112/trade-blotter-ts.git
cd trade-blotter-ts
npm ci
```

`npm ci` installs exactly the versions in `package-lock.json` for both workspaces (`server/` and
`client/`) and never edits the lockfile. No package runs an install script. It reports
moderate advisories from `npm audit` (15 on 2026-11-13); see
[Dependency advisories](../README.md#dependency-advisories).

The repository uses LF line endings (`.gitattributes`). If Git converts them on Windows, run
`git config core.autocrlf false` in the clone and check out again.

### Installing without internet access

`npm ci` needs every locked package for your platform, including the native Vite packages
`@rolldown/binding-<platform>` and `lightningcss-<platform>`.

- **From an npm cache:** `npm ci --offline` installs from the cache and fails at once with
  `ENOTCACHED` if anything is missing. A cache must be filled on the same operating system and
  CPU: one filled on Windows lacks the Linux and macOS native packages.
- **From a registry mirror:** point npm's `registry` setting at it. npm requests the same package
  versions from the configured registry. This has not been verified.

## Build and verification

```bash
npm run verify             # all of the steps below, in order; exit code 0 means the setup works
```

`npm run check:ui` (after `npm run build`) runs 49 checks of the page in a real headless browser,
on throwaway databases of its own, and saves screenshots: `npm run check:ui -- --out <folder>`.

One step at a time:

```bash
npm run lint               # ESLint over the repository
npm run typecheck          # API and frontend, no output files
npm run build              # API to server/dist/, frontend to client/dist/
npm test -w server         # API and tool tests (1,572: 1,571 run, 1 Linux-only test skipped elsewhere)
npm test -w client         # frontend tests (406)
npm run db:check -w server # the migrations folder has no conflicts (drift is a test: schema-drift.test.ts)
```

The tests need no running server, browser, network or existing database. They create their own
databases in the temp folder, use ports chosen by the operating system, and remove everything
afterwards. The test helpers ignore `HOST`, `PORT`, `DATABASE_PATH` and similar settings in the
environment, and refuse a database inside the repository, so a test run never touches your data.

## Configuration

All settings are optional environment variables. An invalid value stops the API at startup with a
message naming the variable. There are no secrets, credentials or `.env` files.

| Variable | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `HOST` | `localhost` | API | Interface to listen on; `0.0.0.0` accepts remote connections |
| `PORT` | `5299` | API | Port; `0` lets the operating system choose a free port |
| `DATABASE_PATH` | `server/data/trade-blotter.db` | API, `db:migrate` | SQLite file; `:memory:` is refused |
| `LOG_LEVEL` | `info` | API | `fatal`, `error`, `warn`, `info`, `debug` or `trace` |
| `DOCS_ENABLED` | `true` | API | `false` disables Swagger UI and the OpenAPI document |
| `SYMBOL_MAX_LENGTH` | `64` | API | Longest symbol accepted, an integer from 1 to 255 |
| `API_TARGET` | `http://localhost:5299` | Frontend development and preview servers | Where the proxy forwards API requests |

Setting a variable for one command:

```bash
PORT=8080 npm start -w server                       # macOS, Linux, Git Bash
```

```powershell
$env:PORT = '8080'; npm start -w server             # Windows PowerShell
```

```bat
set "PORT=8080" && npm start -w server              :: Windows Command Prompt
```

In PowerShell and Command Prompt the variable stays set for the rest of that terminal session.

## Database

The database is one SQLite file. The default is `server/data/trade-blotter.db` inside the
repository, ignored by Git.

### Creating or updating the database

```bash
npm run db:migrate -w server
```

- **What it does:** creates the file and its folder if needed, applies any pending migration, and
  prints `Database is up to date: <path>`.
- **Running it again:** changes nothing.
- **On failure:** every pending migration is rolled back; it prints
  `Database migration failed; no migration was applied.` with the reason, and exits with code 1.
- **Never destructive:** it never deletes or recreates an existing database.

The API applies pending migrations itself at startup, before it accepts requests, so this step is
optional.

### Using a different file

Set `DATABASE_PATH`. Use an absolute path: a relative one is resolved against the folder the
command runs in, which for `-w server` scripts is `server/`.

```bash
DATABASE_PATH="$HOME/trade-blotter/trades.db" npm run db:migrate -w server                 # macOS, Linux, Git Bash
```

```powershell
$env:DATABASE_PATH = "$HOME/trade-blotter/trades.db"; npm run db:migrate -w server        # Windows PowerShell
```

```bat
set "DATABASE_PATH=%USERPROFILE%/trade-blotter/trades.db" && npm run db:migrate -w server  :: Windows Command Prompt
```

Windows accepts forward slashes or backslashes in the path.

### Inspecting, backing up and starting afresh

- **Inspect** with any SQLite browser or the optional `sqlite3` shell:
  `sqlite3 server/data/trade-blotter.db "select * from trades"`. Decimals and timestamps are
  stored as text, exactly as the API returns them.
- **Back up** with the API stopped: copy the `.db` file together with any `-wal` and `-shm` files
  next to it.
- **Start afresh** with the API stopped: delete the file and its `-wal` and `-shm` files yourself,
  then run `npm run db:migrate -w server`. The application never deletes a database.

### Changing the schema

1. Edit `server/src/infrastructure/database/schema.ts`.
2. Run `npm run db:generate -w server -- --name describe_the_change`. drizzle-kit writes
   `server/drizzle/<timestamp>_describe_the_change/migration.sql` and a snapshot.
3. Review the SQL, run `npm run db:migrate -w server`, and commit the migration folder with the
   schema change.

Migrations are forward-only: correct a mistake with a new migration, never by editing one that
has been applied. `npm test` fails if the schema changes without a migration, and
`npm run db:check -w server` checks the migrations folder for conflicts.

## Starting the API

**From source**, restarting when files change:

```bash
npm run dev -w server      # http://localhost:5299
```

**Compiled**, after `npm run build`:

```bash
npm start -w server        # http://localhost:5299
```

The API opens the database, applies pending migrations, logs `Database ready` and listens. If a
migration fails, it does not start. Check it with:

```bash
curl http://localhost:5299/trades
curl http://localhost:5299/positions
```

In Windows PowerShell, type `curl.exe` instead of `curl`. Swagger UI is at
<http://localhost:5299/documentation> and the OpenAPI document at `/documentation/json`. Stop the
API with Ctrl+C: it finishes requests in progress, closes the database and exits with code 0.

## Starting the frontend

Start the API first, then, in a second terminal:

**Development server**, reloading when files change:

```bash
npm run dev -w client      # http://localhost:5173
```

**Built frontend**, after `npm run build`:

```bash
npm run preview -w client  # http://localhost:4173
```

Both servers forward `/trades`, `/positions` and `/documentation` to the API at `API_TARGET`, so
the browser sees one origin and the API needs no CORS. Stop either with Ctrl+C. To host the built
frontend elsewhere, serve `client/dist/` and forward the same paths to the API.

## Ports and running alongside other services

| Port | What | How to change it |
| --- | --- | --- |
| 5299 | API | `PORT` |
| 5173 | Frontend development server | `-- --port <port>` after the command |
| 4173 | Frontend preview | `-- --port <port>` after the command |
| 5391, 4191 | Reviewer benchmark API and frontend (`review:03`) | Fixed |
| 5392, 4192 | Reviewer scratch API and frontend (`review:03`) | Fixed |

The frontend ports are fixed: if one is taken, Vite stops with an error instead of moving to
another. When you change the API port, point the frontend at it with `API_TARGET`. For example,
to run with a separate database and other ports:

```bash
DATABASE_PATH="$HOME/trade-blotter-test/trades.db" PORT=5399 HOST=127.0.0.1 npm start -w server
API_TARGET=http://127.0.0.1:5399 npm run preview -w client -- --port 4273 --host 127.0.0.1
```

```powershell
$env:DATABASE_PATH = "$HOME/trade-blotter-test/trades.db"; $env:PORT = '5399'; $env:HOST = '127.0.0.1'; npm start -w server
$env:API_TARGET = 'http://127.0.0.1:5399'; npm run preview -w client -- --port 4273 --host 127.0.0.1
```

## Reviewer workflow

Seven commands check a clone end to end, the same on Windows PowerShell and Linux; the README has
[the quick start](../README.md#reviewer-workflow-review01-to-review07). Everything they create is
in `.run/review/`, which Git ignores:

| Path | What |
| --- | --- |
| `.run/review/benchmark.db` | 25,000 deterministic trades (db:seed's generator, dataset version 2, seed `trade-blotter`): 181 symbols, 167 open positions; only ever read |
| `.run/review/scratch.db` | 120 deterministic trades (seed `trade-blotter-scratch`), and whatever you book in the scratch frontend |
| `.run/review/run/benchmark/`, `run/scratch/` | Each pair's run record (process ids, tokens, database, ports) and its `api.log` and `web.log` |
| `.run/review/logs/` | The current run only: `run.json` (its id, and each step's status, times, process and exit code), each step's output (`review-0N.log`; a step run again keeps the earlier one as `review-0N.attempt-<n>.log`), the build log and step 05's command logs |
| `.run/review/logs/history/<run id>/` | Earlier runs' logs and `run.json`, moved there by `review:01` when it starts a new run; a step still marked running then is shown as INTERRUPTED. Logs from before runs were recorded are in `history/before-runs-<time>/`. Nothing in the history is deleted |
| `.run/review/perf/<time>/` | `api.json`, `api.txt`, `ui.json`, `ui.txt` from step 06 |
| `.run/review/disposable/` | Step 04's throwaway booking database, removed after each run |
| `.run/review/development-database.json` | Step 01's SHA-256 of the development database's files, compared by step 07 |
| `.run/review/backups/<pair>-<time>/` | A database step 01 preserved before replacing it: its files as they were, and a `backup.json` with their SHA-256, the trade count and fingerprint, why, and how to restore it |

- **A database is recognised by its dataset's identity, never by a count.** Step 02 seeds only an
  empty database. A database holds its dataset when its trades, in booking order, have the SHA-256
  fingerprint of what the seed generator's current version (`DATASET_VERSION`, now 2) makes for its
  seed and count. A dataset an earlier version made is named as such (version 1 had 24 symbols and
  18 open positions). The scratch database may also hold trades you booked after seeding: they are
  kept, and checked with the application's own accounting.
- **A database holding anything else is preserved, then replaced, by step 01, never cleared.** Such
  a database (an earlier version's dataset, changed trades, or trades booked into the read-only
  benchmark) is copied byte for byte into `.run/review/backups/<pair>-<time>/` before it is opened
  at all; the copy is what is inspected. The backup is verified by opening a second copy (SQLite's
  integrity check, the trade count and the fingerprint of every row must match), the original
  files are checked unchanged since they were copied, and a `backup.json` records it all. Only then
  are the original files removed and a new, empty database made, which step 02 seeds; step 01
  reports this as a WARN with the backup's folder. Nothing is replaced while a reviewer or
  `app:start` application is recorded as using the database (run `npm run review:07` first), and a
  file that is not a sound Trade Blotter database is never replaced: it is reported, unchanged,
  with how to move it away. To restore a backup, stop the reviewer's applications and copy its
  files back, as its `backup.json` says.
- **Only the reviewer's own applications are ever stopped.** Before stopping a pair, step 07 checks
  that its record names the pair's database and ports, that every process is alive and still has
  the random token it was started with in its command line, that it is the only process listening
  on its port, and that the API and frontend answer as that pair's. Anything that does not hold
  (a reused process id, another application, another database, another listener) is reported as
  FAIL and left running, with its record kept. `npm run app:stop` is not used.
- **Ports in use.** Steps 01 and 03 check the four reviewer ports. A port used by another program
  is a WARN in step 01 and stops that pair from starting in step 03 (FAIL); the program is left
  alone.
- **The development database** (`server/data/trade-blotter.db`) is never opened by the workflow.
  Step 01 records the SHA-256 of its file, `-wal` and `-shm`; step 07 compares them. A difference
  is a WARN, not a FAIL: if your own application used it in between, it explains the change, and
  the warning is not evidence that the workflow touched it.
- **Runs and logs.** `.run/review/logs/` holds the current run only (see the table above). Step
  01 starts a run and moves the previous one's logs to `logs/history/<run id>/`; every step prints
  its run's id and ends with the run's summary, where a step not run yet in this run is NOT RUN and
  one whose process ended before it finished is INTERRUPTED. No log is deleted, and moving logs
  never touches a database, backup or fingerprint.
- **Without a browser**, step 05 reports the UI checks and step 06 the UI benchmark as SKIPPED,
  and each ends INCOMPLETE with exit code 3. The browser is found automatically, `CHROME_PATH`
  first when it is set ([Finding a browser](../README.md#finding-a-browser)); under WSL only Linux
  browsers are used.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `npm ci` warns `EBADENGINE`, or refuses with `engine-strict` set | Node.js is not 22.23.1 (or a later 22.x). Install 22.23.1 and check `node --version` in the same terminal. |
| `npm ci` fails with a lockfile error | `package.json` and `package-lock.json` disagree, usually after a manual edit. Restore them from Git. |
| `npm ci` fails with `ENOTCACHED`, `ENOTFOUND` or `ETIMEDOUT` | A package is missing from the cache, or the registry cannot be reached. Check the network or `npm config get registry`. |
| `Cannot find native binding` from Vite or Vitest | The rolldown or lightningcss package for this platform is missing. Delete `node_modules` and run `npm ci` again on the same machine. |
| PowerShell says running scripts is disabled | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or type `npm.cmd` instead of `npm`. |
| `Trade Blotter cannot start on Node.js vX` | The runtime lacks `node:sqlite`, `JSON.rawJSON` or JSON source text. Use Node.js 22.23.1. |
| `Trade Blotter could not start.` and a variable name | That environment variable has an invalid value. |
| `EADDRINUSE`, or `Port 5173 is already in use` | The port is taken. Stop the other process, or choose another port (see [Ports](#ports-and-running-alongside-other-services)). |
| `Database migration failed; no migration was applied.` | The reason follows. ``table `trades` already exists`` means `DATABASE_PATH` points at a file created by something else. Nothing was changed. |
| `database is locked` | Another process is writing to the same file, such as a second API instance or a database browser. Close it or use another `DATABASE_PATH`. |
| The page says "The API is not available" | The frontend server cannot reach the API (`502`), or the API is shutting down (`503`). Start the API and check that `API_TARGET` matches its host and port. |
| The page says "The server could not be reached" | The browser got no response: the frontend server stopped or the network failed. Restart it and reload. |
| The page says "The server could not complete the request" | The API returned `500`. Its log has the details; the page never shows them. |
| Times look shifted | Times are shown in your computer's time zone with the offset beside each; the UTC value is in the tooltip. |
| An `ExperimentalWarning` about SQLite | Node.js marks `node:sqlite` as experimental. The npm scripts suppress it; behaviour is unaffected. |
| Tests fail to delete temporary files on Windows | Antivirus or indexing can briefly lock SQLite's `-wal` and `-shm` files. The tests retry; if it persists, exclude the temp folder from real-time scanning. |
| `review:02` says a database is "unexpected" | It holds something other than its dataset. Nothing was changed: run `npm run review:07`, then `npm run review:01`, which preserves it in a verified backup and replaces it (see [Reviewer workflow](#reviewer-workflow)). |
| `review:01` warns that a database "held" something and was replaced | It held an earlier dataset version, changed trades, or trades booked into the benchmark. Its files are in the backup folder named, unchanged; `backup.json` there says how to restore them. |
| `review:03` says a port "is already in use by another process" | Another program uses a reviewer port (5391, 4191, 5392, 4192). Stop it yourself; the workflow never stops it. |
| `review:07` says "not stopped, left running" | The recorded process could not be confirmed as the reviewer's (its id may now belong to another program). Check the process named; delete `.run/review/run/<pair>/app.json` only once you know the reviewer's applications are not running. |
| `review:05` or `review:06` ends INCOMPLETE (exit code 3) | No Chromium-based browser was found; `review:01`'s browser line lists where it looked. Install Chrome, Edge or Chromium the usual way (or unpack Chrome for Testing into `~/.local/chrome-for-testing/<version>/` on Linux), or set `CHROME_PATH` to one, and run it again. |
| A step fails with "CHROME_PATH does not name a usable browser" | `CHROME_PATH` is set to something that is not a browser this process can run (under WSL, a Windows `.exe`). Correct it, or unset it to let the search find one. |
| A step's log seems to show an old result | Look at the run summary at its end and the run id at its start: `.run/review/logs/` holds the current run only, and earlier runs are in `logs/history/<run id>/`. A step not yet run in this run shows NOT RUN. |
| `npm audit` reports moderate advisories | A known open item; see [Dependency advisories](../README.md#dependency-advisories). Do not run `npm audit fix --force`. |

## Platform limitations

The same commands, with no platform-specific source edits, are meant to work on Windows, Linux
(WSL included) and macOS. The reviewer workflow is run in the environment being developed in.

- **Windows 11 x64** (Node.js 22.23.1, npm 12.0.1, Chrome 157): every command, every test,
  `check:ui`, both benchmarks and the seven reviewer steps, most recently on 2026-11-13.
- **Linux under WSL 2** (Debian 11, Node.js 22.23.1, Chrome for Testing 156 in `~/.local`):
  `check:ui` ran there with Linux Node.js against the Windows checkout, finding the browser without
  `CHROME_PATH` (44 of 44 on 2026-11-13, before the five checks added since); so did the process probe (`/proc`, including thread
  ids), the process manager with a stand-in application (start, tokens, process-group stop,
  reused ids, ports in use), and reviewer steps 01 and 02 and the ownership checks of 07, on a
  temporary folder. The full test suite, the build and the seven reviewer steps were not run there.
- **Linux sandboxes** (for example a container with Playwright's browsers in
  `/opt/playwright-browsers`): not run. The browser search is tested against a described machine
  of that kind (`server/test/scripts/browser.test.ts`).
- **macOS: not run at all.** Its process paths (`ps`, `lsof`) are untested.
- **Native build packages.** Building the frontend and running the tests need the rolldown and
  lightningcss packages for your platform. The lockfile has them for Linux x64 and arm64 (glibc
  and musl), macOS x64 and arm64, Windows x64 and arm64, and FreeBSD x64. Platforms without a
  lightningcss package, such as Linux ppc64 or s390x, cannot build the frontend.
- **Node.js type definitions.** `@types/node` 22.20.5 follows the Node.js 22 API, not the 22.23.1
  release specifically.
- **Stopping the API on Windows.** Use Ctrl+C in its terminal; Windows cannot send SIGTERM to
  another process.
