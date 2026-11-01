import { describe, expect, it } from 'vitest'

import { describeParseFailure } from '../../src/api/json.ts'

describe('API: describing JSON parse failures', () => {
  it('gives a fixed message with the position of a syntax error, never the parser text', () => {
    const error = new SyntaxError(`Unexpected token 'C', "C:/secret/path" is not valid JSON at position 12 (line 1 column 13)`)

    expect(describeParseFailure(error)).toBe('The request body is not valid JSON (at character 12).')
  })

  it('gives a fixed message for a syntax error without a position', () => {
    expect(describeParseFailure(new SyntaxError('Unexpected end of JSON input'))).toBe('The request body is not valid JSON.')
  })

  it('names a forbidden prototype property without quoting the body', () => {
    expect(describeParseFailure(new SyntaxError('Object contains forbidden prototype property')))
      .toBe('The request body contains a forbidden property name (__proto__, or constructor with prototype).')
  })

  it.each([
    ['an internal error', new Error('JSON number source text is unavailable; refusing to lose decimal precision.')],
    ['a type error', new TypeError('Cannot read properties of undefined')],
    ['a value that is not an error', 'oops'],
  ])('treats %s as a server fault, with no client message', (_name, error) => {
    expect(describeParseFailure(error)).toBeUndefined()
  })
})
