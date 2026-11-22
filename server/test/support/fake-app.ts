import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

/**
 * A stand-in application for the process-manager tests: node fake-app.ts <port> <mode> [childPidFile]
 *
 * - serve: answers every request on 127.0.0.1:<port> with "fake app".
 * - fail: writes a message and exits with code 3 before listening.
 * - hang: runs without ever listening.
 *
 * With a child pid file it also starts a child process that only waits, and writes its id and the
 * token in its command line there, so a test can check that stopping the application stops its
 * children too.
 */
const [port = '0', mode = 'serve', childPidFile] = process.argv.slice(2)

if (mode === 'fail') {
  console.error('fake app: cannot start')
  process.exit(3)
}

if (childPidFile !== undefined) {
  // The token in its command line lets a test's clean-up tell it from a process that later gets its id.
  const token = randomUUID()
  const child = spawn(process.execPath, [`--title=fake-app-child-${token}`, '-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync(childPidFile, `${String(child.pid)} ${token}`)
}

process.on('SIGTERM', () => {
  console.log('fake app: stopping on SIGTERM')
  process.exit(0)
})

if (mode === 'hang') {
  setInterval(() => undefined, 1000)
} else {
  createServer((_request, response) => {
    response.end('fake app')
  }).listen(Number(port), '127.0.0.1', () => {
    console.log(`fake app listening on ${port}`)
  })
}
