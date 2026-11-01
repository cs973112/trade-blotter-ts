/**
 * Position accounting scenarios: the business rules, stated as trade sequences and the position
 * each must produce. Every value is synthetic.
 *
 * Expectations are exact. `averageCost` may be a fraction such as "5/3": the exact weighted
 * average. The application computes it at WORKING_PRECISION significant digits, so a recurring
 * average matches the fraction to within the tolerance in docs/architecture.md ("Numeric policy");
 * a terminating one matches exactly. catalogue.test.ts checks every expectation against an exact
 * rational reference fold.
 */

export type Side = 'Buy' | 'Sell'

/** One trade: side, quantity, price, and optionally its execution time in seconds after the scenario start. */
export type Fill = readonly [side: Side, quantity: string, price: string, at?: number]

export interface PositionScenario {
  readonly symbol: string
  readonly rule: string
  /** In booking order. Trades apply in execution-time order; equal execution times keep booking order. */
  readonly fills: readonly Fill[]
  /** 'flat' positions have zero quantity and are omitted from GET /positions. */
  readonly expected: { readonly netQuantity: string; readonly averageCost: string } | 'flat'
}

/** A worked example through every rule; WALK<n> holds its first n trades. */
const WORKED_EXAMPLE: readonly Fill[] = [
  ['Buy', '100', '10'],
  ['Buy', '100', '20'],
  ['Sell', '50', '25'],
  ['Sell', '150', '18'],
  ['Sell', '100', '12'],
  ['Sell', '100', '16'],
  ['Buy', '50', '11'],
  ['Buy', '250', '13'],
  ['Sell', '100', '9'],
]

const WORKED_EXAMPLE_POSITIONS: readonly PositionScenario['expected'][] = [
  { netQuantity: '100', averageCost: '10' },
  { netQuantity: '200', averageCost: '15' },
  { netQuantity: '150', averageCost: '15' },
  'flat',
  { netQuantity: '-100', averageCost: '12' },
  { netQuantity: '-200', averageCost: '14' },
  { netQuantity: '-150', averageCost: '14' },
  { netQuantity: '100', averageCost: '13' },
  'flat',
]

const WORKED_EXAMPLE_RULES = [
  'open long from flat',
  'increase long: quantity-weighted average',
  'reduce long: average cost unchanged',
  'close long exactly: flat',
  'open short from flat',
  'increase short: quantity-weighted average',
  'reduce short: average cost unchanged',
  'cross short to long: average cost is the crossing price',
  'close long exactly: flat',
]

export const POSITION_SCENARIOS: readonly PositionScenario[] = [
  ...WORKED_EXAMPLE_POSITIONS.map((expected, index) => ({
    symbol: `WALK${String(index + 1)}`,
    rule: `worked example step ${String(index + 1)}: ${WORKED_EXAMPLE_RULES[index] ?? ''}`,
    fills: WORKED_EXAMPLE.slice(0, index + 1),
    expected,
  })),

  // Each rule in isolation.
  { symbol: 'OPEN_LONG', rule: 'open long', fills: [['Buy', '100', '10']], expected: { netQuantity: '100', averageCost: '10' } },
  { symbol: 'OPEN_SHORT', rule: 'open short', fills: [['Sell', '100', '12']], expected: { netQuantity: '-100', averageCost: '12' } },
  {
    symbol: 'INCREASE_LONG', rule: 'increase long',
    fills: [['Buy', '100', '10'], ['Buy', '100', '20']], expected: { netQuantity: '200', averageCost: '15' },
  },
  {
    symbol: 'WEIGHT_BY_QUANTITY', rule: 'the average is weighted by quantity, not by trade count',
    fills: [['Buy', '300', '10'], ['Buy', '100', '30']], expected: { netQuantity: '400', averageCost: '15' },
  },
  {
    symbol: 'INCREASE_SHORT', rule: 'increase short',
    fills: [['Sell', '100', '12'], ['Sell', '100', '16']], expected: { netQuantity: '-200', averageCost: '14' },
  },
  {
    symbol: 'SHORT_TWO_FILLS', rule: 'increase short at different prices',
    fills: [['Sell', '30', '50'], ['Sell', '20', '60']], expected: { netQuantity: '-50', averageCost: '54' },
  },
  {
    symbol: 'REDUCE_LONG', rule: 'reduce long keeps the average',
    fills: [['Buy', '200', '15'], ['Sell', '50', '25']], expected: { netQuantity: '150', averageCost: '15' },
  },
  {
    symbol: 'REDUCE_SHORT', rule: 'reduce short keeps the average',
    fills: [['Sell', '200', '14'], ['Buy', '50', '11']], expected: { netQuantity: '-150', averageCost: '14' },
  },
  { symbol: 'CLOSE_FLAT', rule: 'close exactly', fills: [['Buy', '100', '10'], ['Sell', '100', '12']], expected: 'flat' },
  {
    symbol: 'CLOSE_LONG_REOPEN', rule: 'reopen after closing a long: the old average is forgotten',
    fills: [['Buy', '150', '15'], ['Sell', '150', '18'], ['Buy', '1', '1']], expected: { netQuantity: '1', averageCost: '1' },
  },
  {
    symbol: 'CLOSE_SHORT_REOPEN', rule: 'reopen after closing a short',
    fills: [['Sell', '100', '13'], ['Buy', '100', '9'], ['Buy', '1', '1']], expected: { netQuantity: '1', averageCost: '1' },
  },
  {
    symbol: 'CROSS_TO_SHORT', rule: 'cross long to short',
    fills: [['Buy', '50', '15'], ['Sell', '150', '12']], expected: { netQuantity: '-100', averageCost: '12' },
  },
  {
    symbol: 'CROSS_TO_LONG', rule: 'cross short to long',
    fills: [['Sell', '150', '14'], ['Buy', '250', '13']], expected: { netQuantity: '100', averageCost: '13' },
  },

  // Averages that do not terminate: exact fractions, rounded only when reported.
  {
    symbol: 'AVG_THIRDS', rule: 'recurring average',
    fills: [['Buy', '1', '1'], ['Buy', '2', '2']], expected: { netQuantity: '3', averageCost: '5/3' },
  },
  {
    symbol: 'AVG_THIRDS_THEN_MORE', rule: 'a recurring average feeds the next increase',
    fills: [['Buy', '1', '1'], ['Buy', '2', '2'], ['Buy', '3', '1']], expected: { netQuantity: '6', averageCost: '4/3' },
  },
  {
    symbol: 'AVG_FIFTY_THIRDS', rule: 'recurring average above ten',
    fills: [['Buy', '1', '10'], ['Buy', '2', '20']], expected: { netQuantity: '3', averageCost: '50/3' },
  },
  {
    symbol: 'AVG_CENTS', rule: 'cent prices',
    fills: [['Buy', '100', '10.01'], ['Buy', '200', '10.02']], expected: { netQuantity: '300', averageCost: '601/60' },
  },
  {
    symbol: 'AVG_THREE_FILLS', rule: 'three fills at cent prices',
    fills: [['Buy', '3', '9.99'], ['Buy', '4', '10.01'], ['Buy', '5', '10.03']], expected: { netQuantity: '12', averageCost: '751/75' },
  },
  {
    symbol: 'AVG_ODD_LOTS', rule: 'odd lots',
    fills: [['Buy', '300', '1'], ['Buy', '600', '2'], ['Buy', '7', '3']], expected: { netQuantity: '907', averageCost: '1521/907' },
  },
  {
    symbol: 'AVG_SMALL_FRACTIONS', rule: 'fractional quantity and price',
    fills: [['Buy', '0.333', '0.07'], ['Buy', '1', '1']], expected: { netQuantity: '1.333', averageCost: '102331/133300' },
  },
  {
    symbol: 'AVG_SHORT_THIRDS', rule: 'recurring average on a short',
    fills: [['Sell', '1', '1'], ['Sell', '2', '2'], ['Sell', '3', '1']], expected: { netQuantity: '-6', averageCost: '4/3' },
  },
  {
    symbol: 'AVG_SEVENTHS_THEN_REDUCE', rule: 'a recurring average survives a reduction and feeds an increase',
    fills: [['Buy', '3', '1'], ['Buy', '4', '2'], ['Sell', '2', '5'], ['Buy', '1', '3']],
    expected: { netQuantity: '6', averageCost: '38/21' },
  },
  {
    symbol: 'AVG_LARGE_AND_SMALL', rule: 'large and small quantities together',
    fills: [['Buy', '1000000', '1'], ['Buy', '2000000', '2'], ['Buy', '3', '1']],
    expected: { netQuantity: '3000003', averageCost: '5000003/3000003' },
  },
  {
    symbol: 'AVG_RECURRING_TENTHS', rule: 'a tenths price in a recurring average',
    fills: [['Buy', '1', '7.9'], ['Buy', '2', '8']], expected: { netQuantity: '3', averageCost: '239/30' },
  },
  {
    symbol: 'AVG_REPEATED', rule: 'five successive increases',
    fills: [['Buy', '1', '1'], ['Buy', '2', '2'], ['Buy', '4', '1'], ['Buy', '8', '3'], ['Buy', '16', '1']],
    expected: { netQuantity: '31', averageCost: '49/31' },
  },

  // Precision at the input limits: exact quantities, and an average needing more than 25 digits.
  {
    symbol: 'LIMIT_EXTREMES', rule: 'largest and smallest accepted values in one position',
    fills: [['Buy', '999999999999999.9999999999', '999999999999999.9999999999'], ['Buy', '0.0000000001', '0.0000000001']],
    expected: { netQuantity: '1000000000000000', averageCost: '999999999999999.99999999980000000000000000000000002' },
  },
  {
    symbol: 'LIMIT_FRACTIONAL_CLOSE', rule: 'fractional quantities close exactly, with no floating-point residue',
    fills: [['Buy', '0.1', '3'], ['Buy', '0.2', '3'], ['Sell', '0.3', '4']], expected: 'flat',
  },

  // Ordering.
  {
    symbol: 'ORDER_BY_TIME', rule: 'trades apply in execution-time order, not booking order',
    fills: [['Sell', '100', '50', 2], ['Buy', '100', '10', 0], ['Buy', '100', '30', 1]],
    expected: { netQuantity: '100', averageCost: '20' },
  },
  {
    symbol: 'ORDER_TIES', rule: 'trades with equal execution times apply in booking order',
    fills: [
      ['Buy', '10', '20', 0], ['Sell', '17', '21', 0], ['Buy', '24', '22', 0],
      ['Sell', '31', '23', 0], ['Buy', '38', '24', 0], ['Sell', '45', '25', 0],
    ],
    expected: { netQuantity: '-21', averageCost: '25' },
  },
]
