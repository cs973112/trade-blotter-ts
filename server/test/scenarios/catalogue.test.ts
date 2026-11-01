import { describe, expect, it } from 'vitest'

import { MAX_DECIMAL_PLACES, MAX_INTEGER_DIGITS } from '../../src/domain/decimal.ts'
import {
  abs,
  add,
  canonicalText,
  compare,
  div,
  equals,
  mul,
  neg,
  rational,
  sign,
  ZERO,
  type Rational,
} from '../support/rational.ts'
import { HTTP_SCENARIOS } from './http.ts'
import { POSITION_SCENARIOS, type Fill } from './positions.ts'
import { TRADE_REQUEST_SCENARIOS } from './trade-requests.ts'

/**
 * Checks the scenario catalogue itself, so later phases test against expectations that are
 * known to be right. Positions are recomputed with exact rational arithmetic from the rules in
 * docs/architecture.md; no application code is involved beyond the numeric limits.
 */

interface ReferencePosition {
  readonly netQuantity: Rational
  readonly averageCost: Rational
}

function referenceFold(fills: readonly Fill[]): ReferencePosition {
  // Array.prototype.sort is stable, so equal execution times keep booking order.
  const ordered = [...fills].sort((a, b) => (a[3] ?? 0) - (b[3] ?? 0))
  let netQuantity = ZERO
  let averageCost = ZERO
  for (const [side, quantityText, priceText] of ordered) {
    const quantity = rational(quantityText)
    const price = rational(priceText)
    const signed = side === 'Buy' ? quantity : neg(quantity)
    const next = add(netQuantity, signed)

    if (sign(netQuantity) === 0) {
      averageCost = price // open from flat
    } else if (sign(netQuantity) === sign(signed)) {
      averageCost = div(add(mul(averageCost, abs(netQuantity)), mul(price, quantity)), abs(next)) // increase
    } else if (sign(next) === 0) {
      averageCost = ZERO // close
    } else if (sign(next) !== sign(netQuantity)) {
      averageCost = price // cross through zero
    } // otherwise reduce: average unchanged
    netQuantity = next
  }
  return { netQuantity, averageCost }
}

function isWithinInputLimits(text: string): boolean {
  const value = rational(text)
  const canonical = canonicalText(value)
  const [integer = '', fraction = ''] = canonical.split('.')
  return sign(value) > 0 && integer.length <= MAX_INTEGER_DIGITS && fraction.length <= MAX_DECIMAL_PLACES
}

describe('scenario catalogue: positions', () => {
  it('uses each symbol once', () => {
    const symbols = POSITION_SCENARIOS.map((scenario) => scenario.symbol)
    expect(new Set(symbols).size).toBe(symbols.length)
  })

  it('uses only quantities and prices the API accepts', () => {
    const values = POSITION_SCENARIOS.flatMap((scenario) => scenario.fills.flatMap(([, quantity, price]) => [quantity, price]))
    expect(values.filter((value) => !isWithinInputLimits(value))).toEqual([])
  })

  it.each(POSITION_SCENARIOS.map((scenario) => [scenario.symbol, scenario] as const))(
    '%s matches the exact reference fold',
    (_symbol, scenario) => {
      const actual = referenceFold(scenario.fills)

      if (scenario.expected === 'flat') {
        expect(sign(actual.netQuantity)).toBe(0)
        return
      }
      expect(canonicalText(actual.netQuantity)).toBe(scenario.expected.netQuantity)
      expect(equals(actual.averageCost, rational(scenario.expected.averageCost))).toBe(true)
    },
  )
})

describe('scenario catalogue: trade requests', () => {
  it('names each scenario once', () => {
    const names = TRADE_REQUEST_SCENARIOS.map((scenario) => scenario.name)
    expect(new Set(names).size).toBe(names.length)
  })

  const acceptedScenarios = TRADE_REQUEST_SCENARIOS.flatMap((scenario) =>
    scenario.expected.status === 201 ? [[scenario.name, scenario.expected] as const] : [])

  it.each(acceptedScenarios)('%s: canonical decimals, exact notional, canonical execution time', (_name, expected) => {
    for (const text of [expected.quantity, expected.price]) {
      expect(canonicalText(rational(text))).toBe(text)
      expect(isWithinInputLimits(text)).toBe(true)
    }
    expect(expected.notional).toBe(canonicalText(mul(rational(expected.quantity), rational(expected.price))))
    if (expected.executedAt !== 'server clock') {
      expect(expected.executedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(new Date(expected.executedAt).toISOString()).toBe(expected.executedAt)
    }
  })

  it('names each rejected field once, in request order', () => {
    const order = ['symbol', 'side', 'quantity', 'price', 'executedAt']
    for (const scenario of TRADE_REQUEST_SCENARIOS) {
      if (scenario.expected.status !== 400) continue
      const positions = scenario.expected.fields.map((field) => order.indexOf(field))
      expect(positions, scenario.name).toEqual([...positions].sort((a, b) => a - b))
      expect(new Set(positions).size, scenario.name).toBe(positions.length)
    }
  })
})

describe('scenario catalogue: HTTP', () => {
  it('names each scenario once', () => {
    const names = HTTP_SCENARIOS.map((scenario) => scenario.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every 405 an Allow header and nothing else one', () => {
    for (const scenario of HTTP_SCENARIOS) {
      expect(scenario.expected.allow !== undefined, scenario.name).toBe(scenario.expected.status === 405)
    }
  })
})

describe('rational oracle', () => {
  it('parses decimals, exponents and fractions exactly', () => {
    expect(canonicalText(rational('1.50E+1'))).toBe('15')
    expect(canonicalText(rational('25e-1'))).toBe('2.5')
    expect(canonicalText(rational('-0.000'))).toBe('0')
    expect(compare(rational('5/3'), rational('1.6666666666666666666666666666666666'))).toBe(1)
  })
})
