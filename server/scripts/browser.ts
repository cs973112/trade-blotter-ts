import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/**
 * Finding a Chromium-based browser for the tools that drive one over the DevTools protocol (the UI
 * benchmark, and the reviewer's browser checks). Nothing is installed and no path is configured in
 * the repository; the order is:
 *
 *   1. CHROME_PATH, when set. If it does not name a browser this process can run, that is an error
 *      (with how to correct it), never a silent fall back to another browser.
 *   2. Browsers installed on the system: Google Chrome, then Microsoft Edge, then Chromium on
 *      Windows; Google Chrome, then Chromium on Linux (the PATH and /opt/google/chrome); Google
 *      Chrome on macOS.
 *   3. Browsers downloaded for testing, newest version first: Chrome for Testing unpacked into
 *      ~/.local/chrome-for-testing/<version>, then in Puppeteer's cache; then Chromium or Chrome for
 *      Testing in Playwright's cache (or PLAYWRIGHT_BROWSERS_PATH) and, on Linux, in the shared
 *      folder /opt/playwright-browsers. Versions and build names are read from the folders.
 *
 * Under WSL the tools run as Linux processes, which cannot drive a Windows browser (it would not
 * see the Linux temporary profile it is given), so Windows programs are never chosen there.
 *
 * Everything the search reads comes through a BrowserHost, so tests can describe any machine.
 */

/** What the search may look at: the platform, the environment, and the file system. */
export interface BrowserHost {
  readonly platform: NodeJS.Platform
  readonly env: NodeJS.ProcessEnv
  /** The user's home folder. */
  readonly home: string
  /** A Linux process running under Windows Subsystem for Linux. */
  readonly wsl: boolean
  /** What is at a path: a file this process may run, another file, a folder, or nothing. */
  kind(path: string): 'executable' | 'file' | 'directory' | 'missing'
  /** The names in a folder; none when it does not exist or cannot be read. */
  list(path: string): readonly string[]
}

export interface FoundBrowser {
  readonly kind: 'found'
  readonly path: string
  /** Where it was found, such as "Microsoft Edge" or "Chrome for Testing 131.0.6778.85 (Puppeteer cache)". */
  readonly description: string
}

export type BrowserLookup =
  | FoundBrowser
  /** Nothing usable was found; `diagnostics` says where the search looked and what to do. */
  | { readonly kind: 'missing'; readonly diagnostics: string }
  /** CHROME_PATH is set but does not name a browser this process can run. */
  | { readonly kind: 'invalid-setting'; readonly message: string }

/** One place the search looked, and why it was not used (undefined: it was). */
export interface Probe {
  readonly description: string
  readonly path: string
  readonly problem?: string
}

export function systemHost(): BrowserHost {
  const env = process.env
  return {
    platform: process.platform,
    env,
    home: homedir(),
    wsl: process.platform === 'linux' && (env['WSL_DISTRO_NAME'] !== undefined || env['WSL_INTEROP'] !== undefined || procVersionMentionsMicrosoft()),
    kind: (path) => {
      try {
        const stats = statSync(path)
        if (stats.isDirectory()) return 'directory'
        if (!stats.isFile()) return 'file'
        if (process.platform === 'win32') return 'executable'
        accessSync(path, constants.X_OK)
        return 'executable'
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EACCES' ? 'file' : 'missing'
      }
    },
    list: (path) => {
      try {
        return readdirSync(path)
      } catch {
        return []
      }
    },
  }
}

function procVersionMentionsMicrosoft(): boolean {
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

const pathFor = (host: BrowserHost): typeof posix => host.platform === 'win32' ? win32 : posix

/** A Windows program, which a Linux process under WSL cannot drive. */
function windowsProgram(path: string): boolean {
  return /\.exe$/i.test(path) || /^\/mnt\/[a-z]\//i.test(path)
}

/** Why a path cannot be used as the browser, or undefined when it can. */
function problemWith(host: BrowserHost, path: string): string | undefined {
  if (host.wsl && windowsProgram(path)) {
    return 'a Windows program: under WSL these tools run as Linux processes and can drive only a Linux browser'
  }
  switch (host.kind(path)) {
    case 'executable': return undefined
    case 'file': return 'not executable (check its permissions)'
    case 'directory': return 'a folder, not the browser\'s program file'
    case 'missing': return 'not found'
  }
}

/** Version text compared number by number, highest first: 131.0.6778.85 before 131.0.6778.9. */
function newestFirst(a: string, b: string): number {
  const [x, y] = [a.split(/\D+/).filter(Boolean).map(Number), b.split(/\D+/).filter(Boolean).map(Number)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (y[i] ?? -1) - (x[i] ?? -1)
    if (difference !== 0) return difference
  }
  return b.localeCompare(a)
}

interface Candidate {
  readonly description: string
  readonly path: string
}

/** Browsers installed on the system, in the order they are preferred. */
function installed(host: BrowserHost): { readonly candidates: Candidate[]; readonly notes: string[] } {
  const path = pathFor(host)
  const { env } = host
  if (host.platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter((root): root is string => root !== undefined && root !== '')
    const at = (description: string, ...parts: string[]): Candidate[] => roots.map((root) => ({ description, path: path.join(root, ...parts) }))
    return {
      candidates: [
        ...at('Google Chrome', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ...at('Microsoft Edge', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ...at('Chromium', 'Chromium', 'Application', 'chrome.exe'),
      ],
      notes: [],
    }
  }
  if (host.platform === 'darwin') {
    const app = 'Google Chrome.app/Contents/MacOS/Google Chrome'
    return { candidates: [{ description: 'Google Chrome', path: `/Applications/${app}` }, { description: 'Google Chrome', path: path.join(host.home, 'Applications', app) }], notes: [] }
  }
  // Linux and other systems: the PATH, then Chrome's own install folder. Under WSL the PATH
  // usually includes Windows folders (/mnt/c/...), whose programs cannot be used.
  const dirs = (env['PATH'] ?? '').split(':').filter((dir) => dir !== '')
  const usable = host.wsl ? dirs.filter((dir) => !windowsProgram(`${dir}/`)) : dirs
  const names: readonly (readonly [string, string])[] = [
    ['google-chrome', 'Google Chrome'], ['google-chrome-stable', 'Google Chrome'], ['chromium', 'Chromium'], ['chromium-browser', 'Chromium'],
  ]
  const skipped = dirs.length - usable.length
  return {
    candidates: [
      ...names.flatMap(([name, description]) => usable.map((dir) => ({ description: `${description} (${name} on the PATH)`, path: path.join(dir, name) }))),
      { description: 'Google Chrome', path: '/opt/google/chrome/chrome' },
    ],
    notes: [
      `On the PATH: ${names.map(([name]) => name).join(', ')} in ${String(usable.length)} folders` +
        (skipped > 0 ? `; ${String(skipped)} Windows folders (/mnt/...) skipped under WSL` : ''),
    ],
  }
}

/** The folders that hold downloaded test browsers, for this platform. */
function caches(host: BrowserHost): { readonly puppeteer: string; readonly playwright: string | undefined } {
  const path = pathFor(host)
  const { env } = host
  const puppeteer = env['PUPPETEER_CACHE_DIR']?.trim() || path.join(host.home, '.cache', 'puppeteer')
  const configured = env['PLAYWRIGHT_BROWSERS_PATH']?.trim()
  // PLAYWRIGHT_BROWSERS_PATH=0 keeps browsers inside node_modules, which this repository does not install.
  if (configured === '0') return { puppeteer, playwright: undefined }
  if (configured !== undefined && configured !== '') return { puppeteer, playwright: configured }
  const playwright = host.platform === 'win32'
    ? (env['LOCALAPPDATA'] === undefined || env['LOCALAPPDATA'] === '' ? undefined : path.join(env['LOCALAPPDATA'], 'ms-playwright'))
    : host.platform === 'darwin' ? path.join(host.home, 'Library', 'Caches', 'ms-playwright')
      : path.join(env['XDG_CACHE_HOME']?.trim() || path.join(host.home, '.cache'), 'ms-playwright')
  return { puppeteer, playwright }
}

/** Program files inside one downloaded browser's folder, by platform, as the two tools lay them out. */
function downloadedPrograms(host: BrowserHost, folder: string, tool: 'puppeteer' | 'playwright'): string[] {
  const path = pathFor(host)
  const testingApp = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  if (host.platform === 'win32') return [path.join(folder, 'chrome-win64', 'chrome.exe'), ...(tool === 'playwright' ? [path.join(folder, 'chrome-win', 'chrome.exe')] : [])]
  if (host.platform === 'darwin') {
    return [
      path.join(folder, 'chrome-mac-arm64', testingApp), path.join(folder, 'chrome-mac-x64', testingApp),
      ...(tool === 'playwright' ? [path.join(folder, 'chrome-mac', 'Chromium.app/Contents/MacOS/Chromium')] : []),
    ]
  }
  return [path.join(folder, 'chrome-linux64', 'chrome'), ...(tool === 'playwright' ? [path.join(folder, 'chrome-linux', 'chrome')] : [])]
}

/** A shared Playwright browsers folder on Linux machines that install browsers once for every user. */
export const SHARED_PLAYWRIGHT_FOLDER = '/opt/playwright-browsers'

/**
 * Folders in a Playwright browsers folder that hold no full Chromium: the headless shell, other
 * browsers, and Playwright's own tools. Any other folder is probed, whatever its build name.
 */
const NOT_CHROMIUM = /^(?:\.|chromium[_-]headless[_-]shell|ffmpeg|firefox|webkit|winldd|android)/i

/** "chromium-1200" is revision 1200; any other build folder is described by its name. */
function playwrightBuild(name: string): string {
  return /^chromium-\d+$/.test(name) ? `Chromium revision ${name.slice('chromium-'.length)}` : `Chromium build ${name}`
}

/** Downloaded test browsers, newest first within each cache; and a line for each cache searched. */
function downloaded(host: BrowserHost): { readonly candidates: Candidate[]; readonly notes: string[] } {
  const path = pathFor(host)
  const { puppeteer, playwright } = caches(host)
  const candidates: Candidate[] = []
  const notes: string[] = []

  // Chrome for Testing unpacked by hand into the user's own folder: ~/.local/chrome-for-testing/<version>/chrome-<platform>/...
  const testingDir = path.join(host.home, '.local', 'chrome-for-testing')
  const testingVersions = host.list(testingDir).filter((name) => !name.startsWith('.')).sort(newestFirst)
  notes.push(`Chrome for Testing folder ${testingDir}: ${testingVersions.length === 0 ? 'no versions' : testingVersions.join(', ')}`)
  for (const version of testingVersions) {
    for (const program of downloadedPrograms(host, path.join(testingDir, version), 'puppeteer')) {
      candidates.push({ description: `Chrome for Testing ${version} (${testingDir})`, path: program })
    }
  }

  // Puppeteer: <cache>/chrome/<platform>-<version>/chrome-<platform>/chrome, such as win64-131.0.6778.85.
  const prefix = host.platform === 'win32' ? ['win64-'] : host.platform === 'darwin' ? ['mac_arm-', 'mac-'] : ['linux-']
  const chromeDir = path.join(puppeteer, 'chrome')
  const versions = host.list(chromeDir).filter((name) => prefix.some((p) => name.startsWith(p)))
    .sort((a, b) => newestFirst(a.replace(/^[^-]+-/, ''), b.replace(/^[^-]+-/, '')))
  notes.push(`Puppeteer cache ${chromeDir}: ${versions.length === 0 ? 'no Chrome for Testing versions' : versions.join(', ')}`)
  for (const name of versions) {
    for (const program of downloadedPrograms(host, path.join(chromeDir, name), 'puppeteer')) {
      candidates.push({ description: `Chrome for Testing ${name.replace(/^[^-]+-/, '')} (Puppeteer cache)`, path: program })
    }
  }

  // Playwright: <folder>/<build>/chrome-<platform>/..., such as chromium-1194. The user's cache (or
  // PLAYWRIGHT_BROWSERS_PATH), then on Linux the shared folder some machines install into.
  if (playwright === undefined) notes.push('Playwright cache: not searched (PLAYWRIGHT_BROWSERS_PATH=0 keeps browsers in node_modules)')
  const shared = host.platform !== 'win32' && host.platform !== 'darwin' && playwright !== SHARED_PLAYWRIGHT_FOLDER ? [SHARED_PLAYWRIGHT_FOLDER] : []
  for (const [folder, label] of [...(playwright === undefined ? [] : [[playwright, 'Playwright cache'] as const]), ...shared.map((dir) => [dir, `Playwright browsers in ${dir}`] as const)]) {
    const builds = host.list(folder).filter((name) => !NOT_CHROMIUM.test(name)).sort(newestFirst)
    notes.push(`${label === 'Playwright cache' ? `Playwright cache ${folder}` : `Playwright browsers folder ${folder}`}: ${builds.length === 0 ? 'no Chromium revisions' : builds.join(', ')}`)
    for (const name of builds) {
      for (const program of downloadedPrograms(host, path.join(folder, name), 'playwright')) {
        candidates.push({ description: `${playwrightBuild(name)} (${label})`, path: program })
      }
    }
  }
  return { candidates, notes }
}

/** Every place to look, in order, with what to say about the searches that list no single path. */
export function browserCandidates(host: BrowserHost): { readonly candidates: readonly Candidate[]; readonly notes: readonly string[] } {
  const system = installed(host)
  const tests = downloaded(host)
  return { candidates: [...system.candidates, ...tests.candidates], notes: [...system.notes, ...tests.notes] }
}

/** The browser to use, or why there is none. See the module comment for the order. */
export function lookUpBrowser(host: BrowserHost = systemHost()): BrowserLookup {
  const configured = host.env['CHROME_PATH']
  if (configured !== undefined && configured.trim() !== '') {
    const path = configured.trim()
    const problem = problemWith(host, path)
    if (problem === undefined) return { kind: 'found', path, description: 'CHROME_PATH' }
    return {
      kind: 'invalid-setting',
      message: `CHROME_PATH is set to ${path}, which is ${problem}. Set CHROME_PATH to the program file of Google Chrome, ` +
        'Microsoft Edge or Chromium (for example chrome.exe or msedge.exe on Windows, or the chrome or chromium program on Linux), ' +
        'or unset it to search the usual places. No other browser was tried, and nothing was installed.',
    }
  }

  const { candidates, notes } = browserCandidates(host)
  const probes: Probe[] = []
  for (const candidate of candidates) {
    const problem = problemWith(host, candidate.path)
    if (problem === undefined) return { kind: 'found', path: candidate.path, description: candidate.description }
    probes.push({ ...candidate, problem })
  }
  return { kind: 'missing', diagnostics: describeSearch(host, probes, notes) }
}

/** What a search that found nothing looked at, and what to do. PATH probes are summarised, not listed. */
function describeSearch(host: BrowserHost, probes: readonly Probe[], notes: readonly string[]): string {
  const listed = probes.filter((probe) => !probe.description.includes(' on the PATH)'))
    .map((probe) => `${probe.description}: ${probe.path}: ${probe.problem ?? ''}`)
  const advice = host.wsl
    ? 'Under WSL, install Google Chrome, Chromium or Chrome for Testing inside the Linux distribution (for example in ' +
      '~/.local/chrome-for-testing/<version>/chrome-linux64), or set CHROME_PATH to a Linux browser; ' +
      'or run the command from Windows, where Chrome and Edge are found.'
    : host.platform === 'win32'
      ? 'Install Google Chrome or Microsoft Edge, or set CHROME_PATH to a Chromium-based browser\'s program file.'
      : 'Install Google Chrome, Chromium or Chrome for Testing, or set CHROME_PATH to a Chromium-based browser\'s program file.'
  return ['CHROME_PATH: not set', ...listed, ...notes, `${advice} Nothing was installed.`].join('\n')
}

/**
 * A browser named on a command line (--chrome) must be usable as given; nothing else is tried.
 * Returns the problem, or undefined when the path can be used.
 */
export function explicitBrowserProblem(path: string, host: BrowserHost = systemHost()): string | undefined {
  const problem = problemWith(host, path)
  return problem === undefined ? undefined : `--chrome ${path} ${problem === 'not found' ? 'does not exist' : `is ${problem}`}.`
}
