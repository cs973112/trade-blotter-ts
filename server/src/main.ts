import { detectPlatformFeatures, platformProblems, unsupportedPlatformMessage } from './platform.ts'

// Composition root. The runtime check runs before anything that imports node:sqlite is loaded,
// which is why the rest of the application is imported dynamically.
const problems = platformProblems(detectPlatformFeatures())

if (problems.length > 0) {
  console.error(unsupportedPlatformMessage(problems))
  process.exitCode = 1
} else {
  const { loadConfig } = await import('./config.ts')
  const { startServer } = await import('./server.ts')
  try {
    await startServer(loadConfig())
  } catch (error) {
    // Invalid configuration, a failed migration or a port in use: stop, and say why.
    console.error(`Trade Blotter could not start. ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
