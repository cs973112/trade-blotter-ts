import { join } from 'node:path'

import { runCheckAllCommand } from '../../scripts/check-all-main.ts'
import { superviseCheckAll } from '../../scripts/check-all-supervisor.ts'
import { stopPair } from '../../scripts/review-apps.ts'

/**
 * The check:all launcher in a process of its own, for check-all-main.test.ts:
 * node check-all-launcher.ts <folder> <ports as JSON> <scenario> [check:all arguments...]. It runs
 * check-all-main.ts's runCheckAllCommand, the code npm run check:all runs, with the real supervisor;
 * only the worker is the stand-in (check-all-stand-in-worker.ts, scenario <scenario>), and the run's
 * folders and databases are under <folder>. The exit code is the one the launcher sets.
 */

const [folder = '', portsJson = '{}', scenario = 'pass', ...args] = process.argv.slice(2)
const ports = JSON.parse(portsJson) as { benchmark: [number, number]; scratch: [number, number] }
const trusted = { identity: () => Promise.resolve([]) }

await runCheckAllCommand(args, {
  supervise: (parsed) => superviseCheckAll({
    ...parsed,
    baseDir: join(folder, 'check-all'),
    ports,
    protection: { developmentDatabase: join(folder, 'data', 'trade-blotter.db'), protectedFolder: join(folder, 'data'), runDir: join(folder, 'app-run') },
    worker: { script: join(import.meta.dirname, 'check-all-stand-in-worker.ts'), args: ['--scenario', scenario] },
    stopDependencies: { stopPair: (pair) => stopPair(pair, trusted) },
    buildCopiesRoots: [join(folder, 'server'), join(folder, 'client')],
    graceMs: 2_000,
    pollMs: 100,
  }),
})
