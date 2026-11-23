import { createServer } from 'node:net'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ensureTerminated, formatTermination, isAlive, probeProcess, startApps, TerminationError, terminateOwned,
  type ChildHandle, type OwnedProcess, type ProcessDescription, type ProcessProbe, type TerminationSystem,
} from '../../scripts/lifecycle.ts'
import { isolatedEnv, startNode } from '../support/child-process.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * Confirmed termination (lifecycle.ts, terminateOwned): how a process this program owns is stopped
 * and confirmed gone. Most cases run against a stand-in operating system with a simulated clock,
 * so each outcome (already exited, exiting during clean-up, still alive, refused, too slow) is
 * reproduced exactly, every time. The last ones stop real processes on this machine: only
 * processes these tests started, identified by their handle or token.
 */

const TOKEN = '0f0f0f0f-1111-4222-8333-444444444444'
const NODE = process.platform === 'win32' ? 'node.exe' : 'node'

interface Script {
  /** What signal 0 says at each call, the last repeating. */
  probes: ProcessProbe[]
  /** What SIGKILL by id does: nothing (accepted) or the error code it throws. */
  kill?: 'ESRCH' | 'EPERM'
  /** The process listed for the id, while signal 0 says the id is taken. */
  description?: ProcessDescription
  /** Whether the port answers at each check, the last repeating. */
  port?: boolean[]
}

function fakeSystem(script: Script) {
  let now = 0
  let probeCalls = 0
  let portCalls = 0
  const kills: number[] = []
  const described: number[][] = []
  const system: TerminationSystem = {
    probe: () => script.probes[Math.min(probeCalls++, script.probes.length - 1)] ?? 'exited',
    kill: (pid) => {
      kills.push(pid)
      if (script.kill !== undefined) throw Object.assign(new Error(`kill ${script.kill}`), { code: script.kill })
    },
    describe: (pids) => {
      described.push([...pids])
      return new Map(script.description === undefined ? [] : pids.map((pid) => [pid, script.description as ProcessDescription]))
    },
    portAnswers: () => Promise.resolve(script.port?.[Math.min(portCalls++, script.port.length - 1)] ?? false),
    now: () => now,
    sleep: (ms) => {
      now += ms
      return Promise.resolve()
    },
    nodeName: NODE,
  }
  return { system, kills, described, elapsed: () => now }
}

const recorded = (extra: Partial<OwnedProcess> = {}): OwnedProcess =>
  ({ label: 'API', pid: 4242, token: TOKEN, ports: [{ port: 5391, host: '127.0.0.1' }], ...extra })
const ours: ProcessDescription = { name: NODE, commandLine: `${NODE} --title=trade-blotter-api-${TOKEN} dist/main.js` }

describe('signal 0: ESRCH and EPERM are told apart', () => {
  const throwing = (code: string) => () => { throw Object.assign(new Error(`kill ${code}`), { code }) }

  it('reads success as alive, ESRCH as exited and EPERM as a process that may not be signalled', () => {
    expect(probeProcess(1, () => undefined)).toBe('alive')
    expect(probeProcess(1, throwing('ESRCH'))).toBe('exited')
    expect(probeProcess(1, throwing('EPERM'))).toBe('no-permission')
    expect(() => probeProcess(1, throwing('EINVAL'))).toThrow('kill EINVAL')
  })

  it('never counts an EPERM process as gone', () => {
    // isAlive keeps its meaning: an id some process holds, whoever owns it.
    expect(isAlive(process.pid)).toBe(true)
  })
})

describe('terminateOwned: a stand-in operating system and clock', () => {
  it('a process that has already exited: nothing is sent, and its port is confirmed released', async () => {
    const { system, kills } = fakeSystem({ probes: ['exited'] })

    const report = await terminateOwned(recorded(), { timeoutMs: 5_000 }, system)

    expect(report).toMatchObject({ outcome: 'already-exited', ok: true })
    expect(kills).toEqual([])
    expect(report.events.join('\n')).toMatch(/no process has its id \(ESRCH\)[\s\S]*port 5391 released/)
  })

  it('a process that exits during clean-up: SIGKILL is refused with EPERM, and only ESRCH afterwards confirms it gone', async () => {
    const { system, kills } = fakeSystem({ probes: ['alive', 'no-permission', 'no-permission', 'no-permission', 'exited'], kill: 'EPERM', description: ours })

    const report = await terminateOwned(recorded(), { timeoutMs: 5_000, intervalMs: 100 }, system)

    expect(report).toMatchObject({ outcome: 'exited-during-cleanup', ok: true })
    expect(kills).toEqual([4242])
    const events = report.events.join('\n')
    expect(events).toMatch(/SIGKILL refused: EPERM/)
    expect(events).toMatch(/no process has its id \(ESRCH\)/)
    // EPERM was seen three times after the refusal and never taken as the end.
    expect(report.elapsedMs).toBeGreaterThanOrEqual(300)
  })

  it('a process that had exited when SIGKILL arrived (ESRCH) is still confirmed before it counts as gone', async () => {
    const { system } = fakeSystem({ probes: ['alive', 'alive', 'exited'], kill: 'ESRCH', description: ours })

    const report = await terminateOwned(recorded(), { timeoutMs: 5_000 }, system)

    expect(report).toMatchObject({ outcome: 'exited-during-cleanup', ok: true })
    expect(report.events.join('\n')).toMatch(/SIGKILL: ESRCH[\s\S]*no process has its id \(ESRCH\)/)
  })

  it('a process that accepts SIGKILL and stops is terminated', async () => {
    const { system, kills } = fakeSystem({ probes: ['alive', 'alive', 'exited'], description: ours })

    expect(await terminateOwned(recorded(), {}, system)).toMatchObject({ outcome: 'terminated', ok: true })
    expect(kills).toEqual([4242])
  })

  it('a process that remains alive after SIGKILL fails at the deadline, with what was seen', async () => {
    const { system, elapsed } = fakeSystem({ probes: ['alive'], description: ours })

    const report = await terminateOwned(recorded(), { timeoutMs: 2_000, intervalMs: 100 }, system)

    expect(report).toMatchObject({ outcome: 'still-alive', ok: false })
    expect(elapsed()).toBeGreaterThanOrEqual(2_000)
    expect(elapsed()).toBeLessThan(2_200)
    expect(formatTermination(report)).toMatch(/^API \(process 4242\): still-alive after \d+ ms\n[\s\S]*SIGKILL sent[\s\S]*command line holds the token/)
  })

  it('a process that cannot be terminated (EPERM, still ours) fails, and ensureTerminated throws with the diagnostics', async () => {
    const { system } = fakeSystem({ probes: ['alive', 'no-permission'], kill: 'EPERM', description: ours })

    const error = await ensureTerminated([recorded()], { timeoutMs: 1_500 }, system).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TerminationError)
    const { reports, message } = error as TerminationError
    expect(reports.map((report) => [report.outcome, report.ok])).toEqual([['cannot-terminate', false]])
    expect(message).toMatch(/1 owned process\(es\) not confirmed stopped:\nAPI \(process 4242\): cannot-terminate/)
    expect(message).toMatch(/SIGKILL refused: EPERM/)
  })

  it('clean-up that exceeds the allowed time fails: the process went, but its port still answered at the deadline', async () => {
    const { system, elapsed } = fakeSystem({ probes: ['alive', 'exited'], description: ours, port: [true] })

    const report = await terminateOwned(recorded(), { timeoutMs: 3_000, intervalMs: 250 }, system)

    expect(report).toMatchObject({ outcome: 'port-in-use', ok: false })
    expect(report.events.at(-1)).toMatch(/port 5391 still answers on 127\.0\.0\.1/)
    expect(elapsed()).toBeGreaterThanOrEqual(3_000)
    expect(elapsed()).toBeLessThan(3_500)
  })

  it('a process that would exit only after the deadline is reported, not waited for without end', async () => {
    const probes: ProcessProbe[] = [...(Array(100).fill('alive') as ProcessProbe[]), 'exited']
    const { system, elapsed } = fakeSystem({ probes, description: ours })

    expect((await terminateOwned(recorded(), { timeoutMs: 1_000, intervalMs: 100 }, system)).outcome).toBe('still-alive')
    expect(elapsed()).toBeLessThan(1_200)
  })

  it('never signals a process whose id was reused: a command line without the token', async () => {
    const { system, kills } = fakeSystem({ probes: ['alive'], description: { name: NODE, commandLine: `${NODE} someone-elses-script.js` } })

    expect(await terminateOwned(recorded(), {}, system)).toMatchObject({ outcome: 'pid-reused', ok: true })
    expect(kills).toEqual([])
  })

  it('never signals an EPERM process of another program; its id was reused, so ours has gone', async () => {
    const { system, kills } = fakeSystem({ probes: ['no-permission'], description: { name: 'svchost.exe' } })

    const report = await terminateOwned(recorded(), {}, system)

    expect(report).toMatchObject({ outcome: 'pid-reused', ok: true })
    expect(report.events[0]).toMatch(/may not be signalled \(EPERM\): svchost\.exe, another program/)
    expect(kills).toEqual([])
  })

  it('never signals, nor counts as gone, a Node.js process that cannot be identified', async () => {
    const { system, kills } = fakeSystem({ probes: ['no-permission'], description: { name: NODE } })

    const report = await terminateOwned(recorded(), { timeoutMs: 2_000 }, system)

    expect(report).toMatchObject({ outcome: 'unidentified', ok: false })
    expect(report.events.at(-1)).toMatch(/command line cannot be read, so it cannot be identified/)
    expect(kills).toEqual([])
  })

  it('never signals a bare id: without a token or a handle nothing identifies it', async () => {
    const { system, kills } = fakeSystem({ probes: ['alive'] })

    expect(await terminateOwned({ label: 'x', pid: 7 }, { timeoutMs: 500 }, system)).toMatchObject({ outcome: 'unidentified', ok: false })
    expect(kills).toEqual([])
  })

  it('stops a child through its handle, and believes only the handle about its exit', async () => {
    const { system, kills } = fakeSystem({ probes: ['exited'] })
    let exitCode: number | null = null
    const signals: string[] = []
    const handle: ChildHandle = {
      get exitCode() { return exitCode },
      signalCode: null,
      kill: (signal) => {
        signals.push(signal)
        exitCode = 137
        return true
      },
    }

    const report = await terminateOwned({ label: 'child', pid: 99, handle }, {}, system)

    expect(report).toMatchObject({ outcome: 'terminated', ok: true })
    expect(signals).toEqual(['SIGKILL'])
    expect(kills).toEqual([])
  })

  it('reads the command line at most once a second while waiting (each reading starts PowerShell on Windows)', async () => {
    const { system, described } = fakeSystem({ probes: ['alive'], description: ours })

    await terminateOwned(recorded(), { timeoutMs: 3_000, intervalMs: 100 }, system)

    expect(described.length).toBeGreaterThanOrEqual(3)
    expect(described.length).toBeLessThanOrEqual(6)
  })
})

describe('terminateOwned: real processes this test started', () => {
  const env = (dir: string): NodeJS.ProcessEnv => isolatedEnv({ DATABASE_PATH: join(dir, 'unused.db') })

  it('stops a running child through its handle and confirms it has gone', async () => {
    const dir = createTempDir()
    try {
      const child = startNode(['-e', 'setInterval(() => {}, 1000)'], env(dir))
      const reports = await ensureTerminated([{ label: 'waiting child', pid: child.pid ?? 0, handle: child }], { timeoutMs: 15_000 })

      expect(reports[0]).toMatchObject({ outcome: 'terminated', ok: true })
      expect(probeProcess(child.pid ?? 0)).not.toBe('alive')
    } finally {
      removeTempDir(dir)
    }
  }, 30_000)

  it('reports a child that had already exited, without signalling anything', async () => {
    const dir = createTempDir()
    try {
      const child = startNode(['-e', ''], env(dir))
      await new Promise((resolve) => child.once('exit', resolve))

      // Its id may already belong to another program: only the handle is asked, and nothing is signalled.
      expect(await terminateOwned({ label: 'finished child', pid: child.pid ?? 0, handle: child })).toMatchObject({ outcome: 'already-exited', ok: true })
    } finally {
      removeTempDir(dir)
    }
  }, 30_000)

  it('stops a background application by its token and confirms its port is released', async () => {
    const dir = createTempDir()
    try {
      const fake = join(import.meta.dirname, '../support/fake-app.ts')
      const port = await new Promise<number>((resolve) => {
        const server = createServer().listen(0, '127.0.0.1', () => {
          const address = server.address()
          server.close(() => { resolve(typeof address === 'object' && address !== null ? address.port : 0) })
        })
      })
      const url = `http://127.0.0.1:${String(port)}`
      const result = await startApps({
        runDir: join(dir, 'run'), databasePath: join(dir, 'unused.db'), readyTimeoutMs: 20_000,
        launches: [{ name: 'api', label: 'Fake API', args: [fake, String(port), 'serve'], cwd: import.meta.dirname, env: process.env, host: '127.0.0.1', port, url,
          ready: async () => (await fetch(url).then((response) => response.text(), () => '')) === 'fake app' }],
      })
      const app = result.state.apps[0]
      if (app === undefined) throw new Error('not started')

      const [report] = await ensureTerminated([{ label: app.label, pid: app.pid, token: app.token, ports: [{ port, host: '127.0.0.1' }] }], { timeoutMs: 20_000 })

      expect(report).toMatchObject({ outcome: 'terminated', ok: true })
      expect(report?.events.join('\n')).toMatch(new RegExp(`port ${String(port)} released`))
    } finally {
      removeTempDir(dir)
    }
  }, 60_000)
})
