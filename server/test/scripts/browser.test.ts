import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { explicitBrowserProblem, lookUpBrowser, systemHost, type BrowserHost, type BrowserLookup } from '../../scripts/browser.ts'
import { createTempDir, removeTempDir } from '../support/temp-dir.ts'

/**
 * Browser discovery on described machines: every file, folder, variable and platform comes from
 * the test, so each system's search runs on any system, and no browser needs to be installed.
 */

type Kind = 'executable' | 'file'

function machine(platform: NodeJS.Platform, files: Readonly<Record<string, Kind>>, options: {
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  readonly wsl?: boolean
} = {}): BrowserHost {
  const { sep } = platform === 'win32' ? win32 : posix
  const inside = (folder: string): string[] => Object.keys(files).filter((file) => file.startsWith(`${folder}${sep}`))
  return {
    platform,
    env: options.env ?? {},
    home: options.home ?? (platform === 'win32' ? 'C:\\Users\\a' : platform === 'darwin' ? '/Users/a' : '/home/a'),
    wsl: options.wsl ?? false,
    kind: (path) => files[path] ?? (inside(path).length > 0 ? 'directory' : 'missing'),
    list: (path) => [...new Set(inside(path).map((file) => file.slice(path.length + 1).split(sep)[0] ?? ''))],
  }
}

const found = (lookup: BrowserLookup): string => lookup.kind === 'found' ? `${lookup.description}: ${lookup.path}` : lookup.kind
const diagnostics = (lookup: BrowserLookup): string => lookup.kind === 'missing' ? lookup.diagnostics : ''
const message = (lookup: BrowserLookup): string => lookup.kind === 'invalid-setting' ? lookup.message : ''

const WINDOWS_ENV = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const CHROME_X86 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
const CHROME_USER = 'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const windows = (files: Readonly<Record<string, Kind>>, env: NodeJS.ProcessEnv = {}): BrowserHost =>
  machine('win32', files, { env: { ...WINDOWS_ENV, ...env } })

describe('browser discovery: CHROME_PATH', () => {
  it('is used first when it names a browser this process can run', () => {
    expect(found(lookUpBrowser(windows({ [CHROME]: 'executable', 'D:\\Browsers\\chrome.exe': 'executable' }, { CHROME_PATH: ' D:\\Browsers\\chrome.exe ' }))))
      .toBe('CHROME_PATH: D:\\Browsers\\chrome.exe')
    expect(found(lookUpBrowser(machine('linux', { '/opt/my/chrome': 'executable' }, { env: { CHROME_PATH: '/opt/my/chrome' } }))))
      .toBe('CHROME_PATH: /opt/my/chrome')
  })

  it('is an error with how to correct it, never a silent fall back, when set to something unusable', () => {
    const missing = lookUpBrowser(windows({ [CHROME]: 'executable' }, { CHROME_PATH: 'D:\\nowhere\\chrome.exe' }))
    expect(missing.kind).toBe('invalid-setting')
    expect(message(missing)).toContain('CHROME_PATH is set to D:\\nowhere\\chrome.exe, which is not found.')
    expect(message(missing)).toContain('or unset it to search the usual places. No other browser was tried, and nothing was installed.')

    expect(message(lookUpBrowser(windows({ 'D:\\Chrome\\x': 'executable' }, { CHROME_PATH: 'D:\\Chrome' }))))
      .toContain('which is a folder, not the browser\'s program file')
    expect(message(lookUpBrowser(machine('linux', { '/opt/chrome/chrome': 'file' }, { env: { CHROME_PATH: '/opt/chrome/chrome' } }))))
      .toContain('which is not executable (check its permissions)')
  })

  it('is ignored when empty or blank', () => {
    expect(found(lookUpBrowser(windows({ [CHROME]: 'executable' }, { CHROME_PATH: '  ' })))).toBe(`Google Chrome: ${CHROME}`)
  })
})

describe('browser discovery: Windows', () => {
  it('prefers Google Chrome (Program Files, Program Files (x86), then the user\'s own), then Microsoft Edge, then Chromium', () => {
    const chromium = 'C:\\Users\\a\\AppData\\Local\\Chromium\\Application\\chrome.exe'
    expect(found(lookUpBrowser(windows({ [CHROME_USER]: 'executable', [CHROME_X86]: 'executable', [EDGE]: 'executable' })))).toBe(`Google Chrome: ${CHROME_X86}`)
    expect(found(lookUpBrowser(windows({ [CHROME_USER]: 'executable', [EDGE]: 'executable' })))).toBe(`Google Chrome: ${CHROME_USER}`)
    expect(found(lookUpBrowser(windows({ [EDGE]: 'executable', [chromium]: 'executable' })))).toBe(`Microsoft Edge: ${EDGE}`)
    expect(found(lookUpBrowser(windows({ [chromium]: 'executable' })))).toBe(`Chromium: ${chromium}`)
  })

  it('finds downloaded test browsers, newest version first, after installed ones', () => {
    const puppeteer = (version: string): string => `C:\\Users\\a\\.cache\\puppeteer\\chrome\\win64-${version}\\chrome-win64\\chrome.exe`
    const playwright = (revision: number, folder = 'chrome-win64'): string => `C:\\Users\\a\\AppData\\Local\\ms-playwright\\chromium-${String(revision)}\\${folder}\\chrome.exe`
    const caches = {
      [puppeteer('131.0.6778.9')]: 'executable', [puppeteer('131.0.6778.85')]: 'executable', [puppeteer('99.0.1.2')]: 'executable',
      [playwright(1200)]: 'executable', [playwright(1194, 'chrome-win')]: 'executable',
    } as const

    expect(found(lookUpBrowser(windows({ ...caches, [EDGE]: 'executable' })))).toBe(`Microsoft Edge: ${EDGE}`)
    expect(found(lookUpBrowser(windows(caches)))).toBe(`Chrome for Testing 131.0.6778.85 (Puppeteer cache): ${puppeteer('131.0.6778.85')}`)
    expect(found(lookUpBrowser(windows({ [playwright(1194, 'chrome-win')]: 'executable', [playwright(1200)]: 'executable' }))))
      .toBe(`Chromium revision 1200 (Playwright cache): ${playwright(1200)}`)
    expect(found(lookUpBrowser(windows({ [playwright(1194, 'chrome-win')]: 'executable' }))))
      .toBe(`Chromium revision 1194 (Playwright cache): ${playwright(1194, 'chrome-win')}`)
  })

  it('honours PUPPETEER_CACHE_DIR and PLAYWRIGHT_BROWSERS_PATH, and leaves PLAYWRIGHT_BROWSERS_PATH=0 alone', () => {
    const pw = 'E:\\pw\\chromium-1300\\chrome-win64\\chrome.exe'
    const pp = 'E:\\pp\\chrome\\win64-140.0.1.1\\chrome-win64\\chrome.exe'
    expect(found(lookUpBrowser(windows({ [pw]: 'executable' }, { PLAYWRIGHT_BROWSERS_PATH: 'E:\\pw' })))).toBe(`Chromium revision 1300 (Playwright cache): ${pw}`)
    expect(found(lookUpBrowser(windows({ [pp]: 'executable' }, { PUPPETEER_CACHE_DIR: 'E:\\pp' })))).toBe(`Chrome for Testing 140.0.1.1 (Puppeteer cache): ${pp}`)
    const untouched = lookUpBrowser(windows({ [pw]: 'executable' }, { PLAYWRIGHT_BROWSERS_PATH: '0' }))
    expect(untouched.kind).toBe('missing')
    expect(diagnostics(untouched)).toContain('Playwright cache: not searched (PLAYWRIGHT_BROWSERS_PATH=0 keeps browsers in node_modules)')
  })

  it('says where it looked and what to do when nothing is found', () => {
    const lookup = lookUpBrowser(windows({}))
    expect(lookup.kind).toBe('missing')
    expect(diagnostics(lookup).split('\n')).toEqual([
      'CHROME_PATH: not set',
      `Google Chrome: ${CHROME}: not found`,
      `Google Chrome: ${CHROME_X86}: not found`,
      `Google Chrome: ${CHROME_USER}: not found`,
      'Microsoft Edge: C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe: not found',
      `Microsoft Edge: ${EDGE}: not found`,
      'Microsoft Edge: C:\\Users\\a\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe: not found',
      'Chromium: C:\\Program Files\\Chromium\\Application\\chrome.exe: not found',
      'Chromium: C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe: not found',
      'Chromium: C:\\Users\\a\\AppData\\Local\\Chromium\\Application\\chrome.exe: not found',
      'Chrome for Testing folder C:\\Users\\a\\.local\\chrome-for-testing: no versions',
      'Puppeteer cache C:\\Users\\a\\.cache\\puppeteer\\chrome: no Chrome for Testing versions',
      'Playwright cache C:\\Users\\a\\AppData\\Local\\ms-playwright: no Chromium revisions',
      'Install Google Chrome or Microsoft Edge, or set CHROME_PATH to a Chromium-based browser\'s program file. Nothing was installed.',
    ])
  })
})

describe('browser discovery: Linux', () => {
  const PATH = '/usr/local/bin:/usr/bin:/snap/bin'

  it('finds Google Chrome, then Chromium, on the PATH, then /opt/google/chrome', () => {
    const linux = (files: Readonly<Record<string, Kind>>): BrowserHost => machine('linux', files, { env: { PATH } })
    expect(found(lookUpBrowser(linux({ '/snap/bin/chromium': 'executable', '/usr/bin/google-chrome-stable': 'executable' }))))
      .toBe('Google Chrome (google-chrome-stable on the PATH): /usr/bin/google-chrome-stable')
    expect(found(lookUpBrowser(linux({ '/snap/bin/chromium': 'executable', '/opt/google/chrome/chrome': 'executable' }))))
      .toBe('Chromium (chromium on the PATH): /snap/bin/chromium')
    expect(found(lookUpBrowser(linux({ '/opt/google/chrome/chrome': 'executable' })))).toBe('Google Chrome: /opt/google/chrome/chrome')
    // A file that cannot be run is passed over.
    expect(found(lookUpBrowser(linux({ '/usr/bin/google-chrome': 'file', '/usr/bin/chromium-browser': 'executable' }))))
      .toBe('Chromium (chromium-browser on the PATH): /usr/bin/chromium-browser')
  })

  it('finds Playwright\'s Chromium (XDG_CACHE_HOME or ~/.cache) and Puppeteer\'s Chrome for Testing, but not headless shells', () => {
    const files = {
      '/home/a/.cache/ms-playwright/chromium_headless_shell-1300/chrome-linux/headless_shell': 'executable',
      '/home/a/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome': 'executable',
      '/home/a/.cache/ms-playwright/chromium-1194/chrome-linux/chrome': 'executable',
    } as const
    expect(found(lookUpBrowser(machine('linux', files, { env: { PATH } }))))
      .toBe('Chromium revision 1200 (Playwright cache): /home/a/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome')
    expect(found(lookUpBrowser(machine('linux', { '/xdg/ms-playwright/chromium-1/chrome-linux/chrome': 'executable' }, { env: { XDG_CACHE_HOME: '/xdg' } }))))
      .toBe('Chromium revision 1 (Playwright cache): /xdg/ms-playwright/chromium-1/chrome-linux/chrome')
    expect(found(lookUpBrowser(machine('linux', { '/home/a/.cache/puppeteer/chrome/linux-131.0.6778.85/chrome-linux64/chrome': 'executable' }))))
      .toBe('Chrome for Testing 131.0.6778.85 (Puppeteer cache): /home/a/.cache/puppeteer/chrome/linux-131.0.6778.85/chrome-linux64/chrome')
  })

  it('finds Chrome for Testing unpacked into ~/.local/chrome-for-testing/<version>, newest version first', () => {
    const testing = (version: string): string => `/home/a/.local/chrome-for-testing/${version}/chrome-linux64/chrome`
    const files = { [testing('156.0.8078.4')]: 'executable', [testing('156.0.8078.10')]: 'executable', [testing('99.0.1.1')]: 'executable' } as const
    expect(found(lookUpBrowser(machine('linux', files, { env: { PATH } }))))
      .toBe(`Chrome for Testing 156.0.8078.10 (/home/a/.local/chrome-for-testing): ${testing('156.0.8078.10')}`)
    // A version folder without the program (an unfinished unpack) is passed over.
    expect(found(lookUpBrowser(machine('linux', { [testing('99.0.1.1')]: 'executable', '/home/a/.local/chrome-for-testing/200.0.0.0/LICENSE': 'file' }, { env: { PATH } }))))
      .toBe(`Chrome for Testing 99.0.1.1 (/home/a/.local/chrome-for-testing): ${testing('99.0.1.1')}`)
    // Installed browsers come first; the hand-unpacked folder comes before the tools' caches.
    expect(found(lookUpBrowser(machine('linux', { ...files, '/usr/bin/chromium': 'executable' }, { env: { PATH } })))).toBe('Chromium (chromium on the PATH): /usr/bin/chromium')
    expect(found(lookUpBrowser(machine('linux', { [testing('1.0.0.0')]: 'executable', '/home/a/.cache/puppeteer/chrome/linux-200.0.0.0/chrome-linux64/chrome': 'executable' }, { env: { PATH } }))))
      .toBe(`Chrome for Testing 1.0.0.0 (/home/a/.local/chrome-for-testing): ${testing('1.0.0.0')}`)
  })

  it('finds Playwright\'s Chromium in the shared /opt/playwright-browsers folder, whatever the build is called', () => {
    const files = {
      '/opt/playwright-browsers/chromium_headless_shell-1300/chrome-linux/headless_shell': 'executable',
      '/opt/playwright-browsers/chromium-1194/chrome-linux64/chrome': 'executable',
      '/opt/playwright-browsers/chromium-1200/chrome-linux64/chrome': 'executable',
      '/opt/playwright-browsers/ffmpeg-1011/ffmpeg-linux': 'executable',
    } as const
    expect(found(lookUpBrowser(machine('linux', files, { env: { PATH } }))))
      .toBe('Chromium revision 1200 (Playwright browsers in /opt/playwright-browsers): /opt/playwright-browsers/chromium-1200/chrome-linux64/chrome')
    expect(found(lookUpBrowser(machine('linux', { '/opt/playwright-browsers/build-7/chrome-linux64/chrome': 'executable' }, { env: { PATH } }))))
      .toBe('Chromium build build-7 (Playwright browsers in /opt/playwright-browsers): /opt/playwright-browsers/build-7/chrome-linux64/chrome')
    // The user's own cache comes first; the shared folder is searched once when PLAYWRIGHT_BROWSERS_PATH names it.
    expect(found(lookUpBrowser(machine('linux', { ...files, '/home/a/.cache/ms-playwright/chromium-1/chrome-linux/chrome': 'executable' }, { env: { PATH } }))))
      .toBe('Chromium revision 1 (Playwright cache): /home/a/.cache/ms-playwright/chromium-1/chrome-linux/chrome')
    const named = lookUpBrowser(machine('linux', files, { env: { PATH, PLAYWRIGHT_BROWSERS_PATH: '/opt/playwright-browsers' } }))
    expect(found(named)).toBe('Chromium revision 1200 (Playwright cache): /opt/playwright-browsers/chromium-1200/chrome-linux64/chrome')
    // Only the headless shell installed: not a browser these tools can drive.
    const shellOnly = lookUpBrowser(machine('linux', { '/opt/playwright-browsers/chromium_headless_shell-1300/chrome-linux/headless_shell': 'executable' }, { env: { PATH } }))
    expect(shellOnly.kind).toBe('missing')
    expect(diagnostics(shellOnly)).toContain('Playwright browsers folder /opt/playwright-browsers: no Chromium revisions')
  })

  it('does not search the shared Linux folder on Windows or macOS', () => {
    const lookup = lookUpBrowser(windows({ '/opt/playwright-browsers/chromium-1200/chrome-win64/chrome.exe': 'executable' }))
    expect(lookup.kind).toBe('missing')
    expect(diagnostics(lookup)).not.toContain('/opt/playwright-browsers')
  })

  it('an invalid CHROME_PATH is an error even when a browser would be found automatically', () => {
    const lookup = lookUpBrowser(machine('linux', { '/opt/playwright-browsers/chromium-1200/chrome-linux64/chrome': 'executable' },
      { env: { PATH, CHROME_PATH: '/opt/playwright-browsers/chromium-1200/chrome-linux64' } }))
    expect(lookup.kind).toBe('invalid-setting')
    expect(message(lookup)).toContain('which is a folder, not the browser\'s program file')
  })

  it('says where it looked and what to do when nothing is found', () => {
    const lookup = lookUpBrowser(machine('linux', {}, { env: { PATH } }))
    expect(lookup.kind).toBe('missing')
    expect(diagnostics(lookup).split('\n')).toEqual([
      'CHROME_PATH: not set',
      'Google Chrome: /opt/google/chrome/chrome: not found',
      'On the PATH: google-chrome, google-chrome-stable, chromium, chromium-browser in 3 folders',
      'Chrome for Testing folder /home/a/.local/chrome-for-testing: no versions',
      'Puppeteer cache /home/a/.cache/puppeteer/chrome: no Chrome for Testing versions',
      'Playwright cache /home/a/.cache/ms-playwright: no Chromium revisions',
      'Playwright browsers folder /opt/playwright-browsers: no Chromium revisions',
      'Install Google Chrome, Chromium or Chrome for Testing, or set CHROME_PATH to a Chromium-based browser\'s program file. Nothing was installed.',
    ])
  })
})

describe('browser discovery: WSL', () => {
  const PATH = '/usr/bin:/mnt/c/Program Files/Google/Chrome/Application:/mnt/c/WINDOWS/system32'
  const WINDOWS_CHROME = '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'

  it('never chooses a Windows program, and says why and what to do', () => {
    const files = { [WINDOWS_CHROME]: 'executable', '/mnt/c/Program Files/Google/Chrome/Application/google-chrome': 'executable' } as const
    const lookup = lookUpBrowser(machine('linux', files, { env: { PATH }, wsl: true }))
    expect(lookup.kind).toBe('missing')
    expect(diagnostics(lookup)).toContain('On the PATH: google-chrome, google-chrome-stable, chromium, chromium-browser in 1 folders; 2 Windows folders (/mnt/...) skipped under WSL')
    expect(diagnostics(lookup)).toContain('Under WSL, install Google Chrome, Chromium or Chrome for Testing inside the Linux distribution (for example in ' +
      '~/.local/chrome-for-testing/<version>/chrome-linux64), or set CHROME_PATH to a Linux browser; ' +
      'or run the command from Windows, where Chrome and Edge are found. Nothing was installed.')
  })

  it('refuses CHROME_PATH naming a Windows browser', () => {
    const lookup = lookUpBrowser(machine('linux', { [WINDOWS_CHROME]: 'executable' }, { env: { PATH, CHROME_PATH: WINDOWS_CHROME }, wsl: true }))
    expect(message(lookup)).toContain(`CHROME_PATH is set to ${WINDOWS_CHROME}, which is a Windows program: under WSL these tools run as Linux processes and can drive only a Linux browser.`)
  })

  it('finds Chrome for Testing in the distribution automatically, passing over Windows Chrome and Edge', () => {
    const testing = '/home/a/.local/chrome-for-testing/156.0.8078.4/chrome-linux64/chrome'
    const files = {
      [WINDOWS_CHROME]: 'executable',
      '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe': 'executable',
      [testing]: 'executable',
    } as const
    const lookup = lookUpBrowser(machine('linux', files, { env: { PATH }, wsl: true }))
    expect(found(lookup)).toBe(`Chrome for Testing 156.0.8078.4 (/home/a/.local/chrome-for-testing): ${testing}`)
  })

  it('never chooses a Windows program from a cache or the shared folder', () => {
    // A cache folder pointed at a Windows drive holds only Windows programs.
    const lookup = lookUpBrowser(machine('linux', { '/mnt/c/pw/chromium-1200/chrome-linux64/chrome': 'executable' },
      { env: { PATH, PLAYWRIGHT_BROWSERS_PATH: '/mnt/c/pw' }, wsl: true }))
    expect(lookup.kind).toBe('missing')
    expect(diagnostics(lookup)).toContain('Chromium revision 1200 (Playwright cache): /mnt/c/pw/chromium-1200/chrome-linux64/chrome: a Windows program')
  })

  it('uses a Linux browser installed in the distribution', () => {
    expect(found(lookUpBrowser(machine('linux', { '/usr/bin/chromium': 'executable', [WINDOWS_CHROME]: 'executable' }, { env: { PATH }, wsl: true }))))
      .toBe('Chromium (chromium on the PATH): /usr/bin/chromium')
  })

  it('treats the same Windows folders as ordinary folders on Linux outside WSL', () => {
    expect(found(lookUpBrowser(machine('linux', { '/mnt/c/Program Files/Google/Chrome/Application/google-chrome': 'executable' }, { env: { PATH } }))))
      .toBe('Google Chrome (google-chrome on the PATH): /mnt/c/Program Files/Google/Chrome/Application/google-chrome')
  })
})

describe('browser discovery: macOS', () => {
  it('finds Google Chrome in /Applications, then ~/Applications', () => {
    const app = 'Google Chrome.app/Contents/MacOS/Google Chrome'
    expect(found(lookUpBrowser(machine('darwin', { [`/Users/a/Applications/${app}`]: 'executable', [`/Applications/${app}`]: 'executable' }))))
      .toBe(`Google Chrome: /Applications/${app}`)
    expect(found(lookUpBrowser(machine('darwin', { [`/Users/a/Applications/${app}`]: 'executable' })))).toBe(`Google Chrome: /Users/a/Applications/${app}`)
  })
})

describe('browser discovery: --chrome', () => {
  it('must be usable exactly as given', () => {
    expect(explicitBrowserProblem(CHROME, windows({ [CHROME]: 'executable' }))).toBeUndefined()
    expect(explicitBrowserProblem('D:\\no-chrome.exe', windows({ [CHROME]: 'executable' }))).toBe('--chrome D:\\no-chrome.exe does not exist.')
    expect(explicitBrowserProblem('/mnt/c/x/chrome.exe', machine('linux', { '/mnt/c/x/chrome.exe': 'executable' }, { wsl: true })))
      .toContain('is a Windows program')
  })
})

describe('browser discovery: this machine\'s file system', () => {
  let dir = ''

  beforeAll(() => {
    dir = createTempDir()
  })

  afterAll(() => {
    removeTempDir(dir)
  })

  it('tells programs, other files, folders and nothing apart', () => {
    const program = join(dir, 'chrome')
    const other = join(dir, 'notes.txt')
    writeFileSync(program, '')
    writeFileSync(other, '')
    mkdirSync(join(dir, 'folder'))
    if (process.platform !== 'win32') {
      chmodSync(program, 0o755)
      chmodSync(other, 0o644)
    }
    const host = systemHost()

    expect(host.kind(program)).toBe('executable')
    // Windows runs any file by its type, so every file counts as a program there.
    expect(host.kind(other)).toBe(process.platform === 'win32' ? 'executable' : 'file')
    expect(host.kind(join(dir, 'folder'))).toBe('directory')
    expect(host.kind(join(dir, 'missing'))).toBe('missing')
    expect([...host.list(dir)].sort()).toEqual(['chrome', 'folder', 'notes.txt'])
    expect(host.list(join(dir, 'missing'))).toEqual([])
    if (process.platform !== 'linux') expect(host.wsl).toBe(false)
  })
})
