// ES2026 "JSON.parse source text access" (JSON.rawJSON, JSON.isRawJSON and the reviver's
// context.source). Supported by V8 in Node 22 and later, but not yet in TypeScript's
// standard library. Declared here so the lossless JSON code can use it without casts.

interface JsonRawNumber {
  readonly rawJSON: string
}

interface JSON {
  rawJSON(text: string): JsonRawNumber
  isRawJSON(value: unknown): value is JsonRawNumber
}
