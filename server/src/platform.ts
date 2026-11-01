/**
 * Runtime capabilities the server depends on. Checked once at startup, before any module that
 * imports node:sqlite is loaded, so an unsupported Node version fails with a clear message
 * instead of a module resolution error or, worse, silent decimal precision loss.
 */
export interface PlatformFeatures {
  /** The built-in node:sqlite module (unflagged from Node 22.13). */
  readonly sqlite: boolean
  /** JSON.rawJSON, used to write decimals as exact JSON numbers. */
  readonly rawJson: boolean
  /** The JSON.parse reviver's context.source, used to read decimals from their exact text. */
  readonly jsonSourceText: boolean
}

/** The supported runtime: the same range as `engines` in every package.json and `.nvmrc`. */
export const SUPPORTED_NODE_VERSIONS = '^22.23.1'

export function detectPlatformFeatures(): PlatformFeatures {
  // Typed as always present, but undefined on Node versions without the module.
  const sqlite: unknown = process.getBuiltinModule('node:sqlite')
  return {
    sqlite: sqlite !== undefined,
    rawJson: typeof (Reflect.get(JSON, 'rawJSON') as unknown) === 'function',
    jsonSourceText: readsJsonSourceText(),
  }
}

/** One sentence per missing capability; empty when the runtime is supported. */
export function platformProblems(features: PlatformFeatures): string[] {
  const problems: string[] = []
  if (!features.sqlite) problems.push('The built-in node:sqlite module is not available.')
  if (!features.rawJson) problems.push('JSON.rawJSON is not available.')
  if (!features.jsonSourceText) problems.push('JSON.parse does not expose number source text.')
  return problems
}

export function unsupportedPlatformMessage(problems: readonly string[]): string {
  return [
    `Trade Blotter cannot start on Node.js ${process.version}.`,
    ...problems.map((problem) => `  - ${problem}`),
    `Use Node.js ${SUPPORTED_NODE_VERSIONS}.`,
  ].join('\n')
}

function readsJsonSourceText(): boolean {
  let source: string | undefined
  JSON.parse('1.0', (_key, value: unknown, context?: { source?: string }) => {
    source = context?.source
    return value
  })
  return source === '1.0'
}
