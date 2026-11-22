import { resolve } from 'node:path'

import { parseArguments, type Mode } from './check-all.ts'
import { superviseCheckAll, type SupervisedRun } from './check-all-supervisor.ts'
import { EXIT } from './review-context.ts'

/**
 * npm run check:all [-- --quick] [-- --verbose]: the command's entry point (check-all.ts describes
 * the run). It reads the command line and runs the supervisor (check-all-supervisor.ts), which
 * starts the worker; the exit code is the supervisor's: the worker's own for a run it finished, 1 for
 * one it did not, and 2 for a usage error, before anything starts.
 *
 * Nothing imports this module but the launcher test's harness, so no module that is still being
 * evaluated waits for it, and it imports the supervisor statically: the whole command is loaded
 * before the command line is read. It starts nothing when it is imported, only when Node.js runs it.
 */

export interface LaunchDependencies {
  /** Runs the supervisor; the launcher test's harness passes the real one, with a stand-in worker. */
  readonly supervise?: (options: { readonly mode: Mode; readonly verbose: boolean }) => Promise<SupervisedRun>
  readonly printError?: (text: string) => void
  readonly exit?: (code: number) => void
}

/** Runs check:all for `args` and returns its exit code; a run that must end at once (endNow) ends the process with it. */
export async function launchCheckAll(args: readonly string[], dependencies: LaunchDependencies = {}): Promise<number> {
  const parsed = parseArguments(args)
  if ('error' in parsed) {
    ;(dependencies.printError ?? ((text: string) => { console.error(text) }))(parsed.error)
    return 2
  }
  const outcome = await (dependencies.supervise ?? superviseCheckAll)(parsed)
  // A clean-up past its deadline may still be running here, or the worker was not confirmed gone:
  // with the summary written, neither may keep this process alive, so it ends now.
  if (outcome.endNow) (dependencies.exit ?? ((code: number) => process.exit(code)))(outcome.exitCode)
  return outcome.exitCode
}

/** Sets the process's exit code from launchCheckAll; anything it throws is printed, exit code 1. */
export function runCheckAllCommand(args: readonly string[], dependencies: LaunchDependencies = {}): Promise<void> {
  return launchCheckAll(args, dependencies).then(
    (code) => { process.exitCode = code },
    (error: unknown) => {
      console.error(error)
      process.exitCode = EXIT.failed
    },
  )
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  void runCheckAllCommand(process.argv.slice(2))
}
