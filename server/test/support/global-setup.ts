import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { removeTempDir, RUN_VARIABLE, tempDirPrefix } from './temp-dir.ts'

/**
 * Gives this test run an id, which every temporary folder it creates carries in its name, and
 * fails the run if any of its folders are left at the end. Another run on the same machine has a
 * different id, so its folders are never counted or touched.
 */
export default function setup(): () => void {
  process.env[RUN_VARIABLE] = randomUUID().slice(0, 8)
  const serverRoot = join(import.meta.dirname, '../..')

  return () => {
    const prefix = tempDirPrefix()
    const leftovers = [
      ...readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)).map((name) => join(tmpdir(), name)),
      ...readdirSync(serverRoot).filter((name) => name.startsWith(`.test-build-${prefix}`)).map((name) => join(serverRoot, name)),
    ]
    for (const path of leftovers) removeTempDir(path)
    if (leftovers.length > 0) {
      throw new Error(`Tests left ${String(leftovers.length)} temporary folder(s) behind; they have now been removed:\n${leftovers.join('\n')}`)
    }
  }
}
