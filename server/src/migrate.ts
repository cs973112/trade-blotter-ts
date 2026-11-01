import { detectPlatformFeatures, platformProblems, unsupportedPlatformMessage } from './platform.ts'

// `npm run db:migrate`: applies pending migrations to the configured database without starting
// the server. Uses the same code the server will run at startup. Like main.ts, the runtime check
// runs before anything that imports node:sqlite is loaded.
const problems = platformProblems(detectPlatformFeatures())

if (problems.length > 0) {
  console.error(unsupportedPlatformMessage(problems))
  process.exitCode = 1
} else {
  const { loadConfig } = await import('./config.ts')
  const { closeDatabase, openDatabase } = await import('./infrastructure/database/connection.ts')
  const { applyMigrations } = await import('./infrastructure/database/migrate.ts')

  const { databasePath } = loadConfig()
  const db = openDatabase(databasePath)
  try {
    applyMigrations(db)
    console.log(`Database is up to date: ${databasePath}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    closeDatabase(db)
  }
}
