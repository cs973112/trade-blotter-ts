# Setup guide

How to install, configure, verify and run Trade Blotter from a clone of the repository. The
[README](../README.md) has the short version.

- **Verified:** every command here was run on Windows 11 x64 with Node.js 22.23.1 and npm 12.0.1.
- **Intended, not verified:** macOS and Linux. The commands are the same; see
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
9. [Troubleshooting](#troubleshooting)
10. [Platform limitations](#platform-limitations)

## Prerequisites

| Requirement | Detail |
| --- | --- |
| Node.js 22.23.1 | The only supported and verified version (`.nvmrc`). `engines` is `^22.23.1`: later 22.x releases are accepted but not verified; other major versions are not supported. |
| npm 12.0.1 | Bundled with Node.js 22.23.1. |
| Git | To clone the repository. |
| Network access to the npm registry | `npm ci` downloads 300 packages, or see [Installing without internet access](#installing-without-internet-access). |
| A writable temp folder | The tests create temporary databases in the operating system's temp folder. |
| A web browser | Only to use the frontend; no test starts a browser. |
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
`client/`) and never edits the lockfile. No package runs an install script. It reports 19
moderate advisories from `npm audit`; see
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

One step at a time:

```bash
npm run lint               # ESLint over the repository
npm run typecheck          # API and frontend, no output files
npm run build              # API to server/dist/, frontend to client/dist/
npm test -w server         # API tests (1087)
npm test -w client         # frontend tests (220)
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
| `npm audit` reports 16 moderate advisories | A known open item; see [Dependency advisories](../README.md#dependency-advisories). Do not run `npm audit fix --force`. |

## Platform limitations

- **Verified on Windows 11 x64 only.** macOS, Linux and other CPU architectures are intended to
  work but have not been run.
- **Native build packages.** Building the frontend and running the tests need the rolldown and
  lightningcss packages for your platform. The lockfile has them for Linux x64 and arm64 (glibc
  and musl), macOS x64 and arm64, Windows x64 and arm64, and FreeBSD x64. Platforms without a
  lightningcss package, such as Linux ppc64 or s390x, cannot build the frontend.
- **Node.js type definitions.** `@types/node` 22.20.5 follows the Node.js 22 API, not the 22.23.1
  release specifically.
- **Stopping the API on Windows.** Use Ctrl+C in its terminal; Windows cannot send SIGTERM to
  another process.
