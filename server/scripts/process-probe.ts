import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

/**
 * Read-only facts about a running process, for the benchmark: which process listens on a port,
 * and how much memory a process holds. One implementation for Windows, Linux and macOS, on Node.js
 * built-ins and the tools each system ships with. Nothing here signals or changes a process.
 */

/**
 * Who listens for TCP connections on a port, on any address, compared with one process:
 * - only: something listens, and every listening socket belongs to that process;
 * - others: at least one listening socket belongs to another process;
 * - none: nothing listens;
 * - unknown: the operating system could not tell.
 */
export type Listeners = 'only' | 'others' | 'none' | 'unknown'

export function listenersOnPort(port: number, pid: number): Listeners {
  if (process.platform === 'win32') return fromProcessIds(windowsListeners(port), pid)
  if (process.platform === 'linux') return linuxListeners(port, pid)
  return fromProcessIds(lsofListeners(port), pid)
}

function fromProcessIds(owners: readonly number[] | undefined, pid: number): Listeners {
  if (owners === undefined) return 'unknown'
  if (owners.length === 0) return 'none'
  return owners.every((owner) => owner === pid) ? 'only' : 'others'
}

/**
 * netstat -ano: a listening socket is the one whose remote address is 0.0.0.0:0 or [::]:0. That
 * is read instead of the state column, whose word ("LISTENING") depends on the display language.
 */
function windowsListeners(port: number): number[] | undefined {
  const result = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  const v6 = spawnSync('netstat', ['-ano', '-p', 'TCPv6'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  if (result.status !== 0 || v6.status !== 0) return undefined
  const owners: number[] = []
  for (const line of `${result.stdout}\n${v6.stdout}`.split(/\r?\n/)) {
    const [protocol, local, remote, ...rest] = line.trim().split(/\s+/)
    if (protocol?.toUpperCase() !== 'TCP' || local === undefined || remote === undefined) continue
    if (!local.endsWith(`:${String(port)}`) || (remote !== '0.0.0.0:0' && remote !== '[::]:0')) continue
    const owner = Number(rest.at(-1))
    if (Number.isInteger(owner)) owners.push(owner)
  }
  return owners
}

/** /proc/net/tcp and tcp6 list listening sockets (state 0A) by inode; /proc/<pid>/fd links to the process's own. */
function linuxListeners(port: number, pid: number): Listeners {
  const inodes = new Set<string>()
  try {
    for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
      for (const line of readFileSync(table, 'utf8').split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/)
        const [local, state, inode] = [fields[1], fields[3], fields[9]]
        if (local === undefined || inode === undefined || state !== '0A') continue
        if (Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 16) === port) inodes.add(inode)
      }
    }
  } catch {
    return 'unknown'
  }
  if (inodes.size === 0) return 'none'
  const own = new Set<string>()
  try {
    for (const fd of readdirSync(`/proc/${String(pid)}/fd`)) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${String(pid)}/fd/${fd}`))
        if (match?.[1] !== undefined) own.add(match[1])
      } catch {
        // Closed while reading.
      }
    }
  } catch {
    return 'unknown'
  }
  return [...inodes].every((inode) => own.has(inode)) ? 'only' : 'others'
}

/** macOS (and other systems): lsof, which exits with 1 when nothing matches. */
function lsofListeners(port: number): number[] | undefined {
  const result = spawnSync('lsof', ['-nP', '-a', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8', timeout: 30_000 })
  if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) return undefined
  return result.stdout.split('\n').filter((line) => line.startsWith('p')).map((line) => Number(line.slice(1)))
}

export interface ProcessMemory {
  /** Resident memory now: the working set on Windows, RSS elsewhere. */
  readonly residentBytes: number
  /** The most it has held since it started, where the system records it (not on macOS). */
  readonly peakResidentBytes: number | undefined
  readonly source: string
}

/** The memory a process holds, or undefined when it cannot be read. */
export function processMemory(pid: number): ProcessMemory | undefined {
  return processesMemory([pid]).get(pid)
}

/**
 * The memory of each of these processes that could be read, by id. On Windows all are asked for
 * in one PowerShell call, because starting PowerShell takes about a second.
 */
export function processesMemory(pids: readonly number[]): Map<number, ProcessMemory> {
  const valid = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0)
  const memories = new Map<number, ProcessMemory>()
  if (valid.length === 0) return memories
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Id ${valid.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.Id + ' ' + [string]$_.WorkingSet64 + ' ' + [string]$_.PeakWorkingSet64 }`],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    for (const line of result.stdout.split(/\r?\n/)) {
      const [pid, now, peak] = line.trim().split(' ').map(Number)
      if (pid === undefined || now === undefined || !Number.isFinite(now) || now <= 0) continue
      memories.set(pid, { residentBytes: now, peakResidentBytes: peak !== undefined && peak > 0 ? peak : undefined, source: 'Windows working set (Get-Process)' })
    }
    return memories
  }
  for (const pid of valid) {
    const memory = singleProcessMemory(pid)
    if (memory !== undefined) memories.set(pid, memory)
  }
  return memories
}

function singleProcessMemory(pid: number): ProcessMemory | undefined {
  if (process.platform === 'linux') {
    let status: string
    try {
      status = readFileSync(`/proc/${String(pid)}/status`, 'utf8')
    } catch {
      return undefined
    }
    const kib = (name: string): number | undefined => {
      const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(status)
      return match?.[1] === undefined ? undefined : Number(match[1]) * 1024
    }
    const now = kib('VmRSS')
    return now === undefined ? undefined : { residentBytes: now, peakResidentBytes: kib('VmHWM'), source: 'Linux VmRSS and VmHWM (/proc)' }
  }
  const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 })
  const kib = Number(result.stdout.trim())
  return result.status !== 0 || !Number.isFinite(kib) || kib <= 0 ? undefined
    : { residentBytes: kib * 1024, peakResidentBytes: undefined, source: 'resident set size (ps)' }
}
