import { Type } from 'typebox'

import { MAX_DECIMAL_PLACES, MAX_INTEGER_DIGITS } from '../domain/decimal.ts'
import { DEFAULT_SYMBOL_MAX_LENGTH } from '../domain/symbol.ts'
import {
  DEFAULT_PAGE_SIZE, DEFAULT_SYMBOL_MATCH, DEFAULT_TRADE_SORT, MAX_PAGE, MAX_PAGE_SIZE, SORT_DIRECTIONS, SYMBOL_MATCHES, TRADE_SORT_FIELDS,
} from '../domain/trade-query.ts'
import { ACTORS, CANCELLATION_REASON_MAX_LENGTH, TRADE_STATUSES } from '../domain/trade-status.ts'
import { TRADE_SIDES } from '../domain/trade.ts'
import { JSON_NUMBER_PATTERN } from './json.ts'

/**
 * The HTTP contract as TypeBox schemas. They document the API in OpenAPI; they do not validate
 * trade fields or query parameters, which is the domain's job (validateTradeRequest,
 * validateTradeQuery), so every error comes from one place with one message. Request bodies are
 * checked only for being a JSON object (TradeRequestContainer). Responses are written by the
 * lossless JSON serializer, not from these schemas. Each schema's $id is its name under
 * components.schemas.
 */

const DECIMAL_RULE =
  `Greater than 0 and less than 10^${String(MAX_INTEGER_DIGITS)}, with at most ${String(MAX_DECIMAL_PLACES)} decimal places. ` +
  'Send a JSON number or a string in JSON number grammar; either way the exact digits are kept.'

const TIMESTAMP_FORMAT = 'Canonical UTC with milliseconds, such as 2026-01-01T09:00:00.000Z.'

const DecimalInput = (description: string) =>
  Type.Union([Type.Number(), Type.String({ pattern: JSON_NUMBER_PATTERN })], { description: `${description} ${DECIMAL_RULE}` })

const DecimalOutput = (description: string, extra: { readOnly?: boolean } = {}) =>
  Type.Number({ description: `${description} Exact: written with every significant digit, never rounded through a binary float.`, ...extra })

const ServerTimestamp = (description: string) =>
  Type.String({ format: 'date-time', readOnly: true, description: `${description} Set by the server. ${TIMESTAMP_FORMAT}` })

export const CreateTradeRequest = Type.Object(
  {
    symbol: Type.String({
      description: 'Trimmed, Unicode NFC-normalised and upper-cased. 1 to the configured maximum characters ' +
        `(default ${String(DEFAULT_SYMBOL_MAX_LENGTH)}); no control or invisible characters.`,
      examples: ['MSFT'],
    }),
    side: Type.String({ description: 'Buy or Sell, ignoring case and surrounding whitespace.', examples: ['Buy'] }),
    quantity: DecimalInput('Units traded.'),
    price: DecimalInput('Price per unit.'),
    status: Type.Optional(Type.Union([Type.String(), Type.Null()], {
      description: 'Pending, ignoring case and surrounding whitespace; omitted or null is Pending too. Every trade is booked Pending. ' +
        'Executed is refused (a trade is executed with POST /trades/{id}/execution), and so is Cancelled (POST /trades/{id}/cancellation).',
      examples: ['Pending'],
    })),
  },
  {
    $id: 'CreateTradeRequest',
    description: 'A trade to book, by User, as Pending. id, bookingSequence, createdAt, updatedAt, createdBy, updatedBy, originalTradeId and ' +
      'cancellationReason are set by the server: members with those names, like any unknown member, are ignored. executedAt is not ' +
      'accepted: the server sets it when the trade is executed, and a booking that gives one (other than null) is refused.',
    examples: [{ symbol: 'MSFT', side: 'Buy', quantity: 100, price: '101.25' }],
  },
)

export const TradeResponse = Type.Object(
  {
    id: Type.String({ format: 'uuid', readOnly: true, description: 'Assigned by the server.' }),
    bookingSequence: Type.Integer({
      minimum: 1,
      readOnly: true,
      description: 'Assigned by the database when the trade is stored; increases with every booking and is never reused. ' +
        'Breaks ties between trades with the same executedAt.',
    }),
    symbol: Type.String({ description: 'Normalised symbol.' }),
    side: Type.Union(TRADE_SIDES.map((side) => Type.Literal(side))),
    quantity: DecimalOutput('Units traded.'),
    price: DecimalOutput('Price per unit.'),
    notional: DecimalOutput('quantity × price.', { readOnly: true }),
    status: Type.Union(TRADE_STATUSES.map((status) => Type.Literal(status)), {
      description: 'Pending, Executed or Cancelled. A cancelled trade is listed once, as Cancelled; its cancellation row is not listed.',
    }),
    executedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()], {
      description: `When an Executed trade was executed: the server clock when it was executed (POST /trades/{id}/execution), or, for a trade booked Executed before M7, the time it was booked with. ${TIMESTAMP_FORMAT} Null for a Pending trade, and for one cancelled while Pending.`,
    }),
    createdAt: ServerTimestamp('When the trade was recorded.'),
    updatedAt: ServerTimestamp('When the record last changed: createdAt, or the time it was executed or cancelled.'),
    createdBy: Type.Union(ACTORS.map((actor) => Type.Literal(actor)), { readOnly: true, description: 'Who booked it: User. Set by the server; a label for the operation, not an authenticated identity (the API has no authentication).' }),
    updatedBy: Type.Union(ACTORS.map((actor) => Type.Literal(actor)), { readOnly: true, description: 'Who last changed it: User (booked or executed), or Admin once cancelled. Set by the server; a label, not an authenticated identity.' }),
    originalTradeId: Type.Union([Type.String(), Type.Null()], {
      readOnly: true,
      description: 'Null for every trade a list shows. On a cancellation record (in a cancellation response, and in audit snapshots), the id of the trade it cancels.',
    }),
    cancellationReason: Type.Union([Type.String(), Type.Null()], { readOnly: true, description: 'Why the trade was cancelled; null unless it is Cancelled.' }),
    cancellationTradeId: Type.Union([Type.String(), Type.Null()], {
      readOnly: true,
      description: 'For a cancelled trade, the id of its cancellation record, whose audit history GET /trades/{id}/audit?scope=logical includes; otherwise null.',
    }),
  },
  { $id: 'Trade', description: 'A logical trade. Decimals are exact JSON numbers; timestamps canonical UTC with milliseconds.' },
)

export const PositionResponse = Type.Object(
  {
    symbol: Type.String(),
    netQuantity: Type.Number({ description: 'The Executed Net, as executedNetQuantity: kept for existing clients. Zero for a symbol with only Pending trades. Exact.' }),
    averageCost: Type.Number({
      description: 'Quantity-weighted average price of the open Executed quantity, from Executed trades only, computed to 50 significant digits ' +
        '(half to even) where the exact value does not terminate. Zero when nothing is executed. Not rounded for display.',
    }),
    executedNetQuantity: Type.Number({ description: 'Signed net quantity of the Executed trades. Exact.' }),
    pendingNetQuantity: Type.Number({ description: 'Signed sum of the Pending trades: a Buy adds, a Sell subtracts. Exact.' }),
    projectedNetQuantity: Type.Number({ description: 'executedNetQuantity + pendingNetQuantity: the position if every Pending trade executed. Exact.' }),
  },
  { $id: 'Position', description: 'A symbol with an Executed Net or a Pending Net other than zero; cancelled trades count for nothing.' },
)

export const Problem = Type.Object(
  {
    type: Type.String({ description: 'about:blank for generic HTTP errors, or a URN naming the problem.' }),
    title: Type.String(),
    status: Type.Integer(),
    detail: Type.Optional(Type.String()),
    errors: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()), {
      description: 'Invalid trade fields, in request order (symbol, side, quantity, price, executedAt, status); invalid query ' +
        'parameters, in documented order (symbol, symbolMatch, side, status, executedFrom, executedTo, sortBy, sortDirection, then page and ' +
        'pageSize for GET /trades/page; scope, page, pageSize for an audit history); or, for a cancellation, reason. Each with its messages.',
    })),
    tradeId: Type.Optional(Type.String({ description: 'The trade a not-found or invalid-transition problem is about.' })),
    symbol: Type.Optional(Type.String({ description: 'The symbol whose position limit would be breached.' })),
  },
  { $id: 'Problem', description: 'RFC 9457 problem details, served as application/problem+json.' },
)

const QueryTimestamp = (description: string, example: string) =>
  Type.String({
    format: 'date-time',
    description: `${description} RFC 3339 date-time with seconds and Z or an offset, at most millisecond precision; ` +
      'a date alone or a time without an offset is refused. In a URL, write + as %2B.',
    examples: [example],
  })

/**
 * GET /trades query parameters. Every parameter is optional, and an empty value is the same as
 * omitting it; filters combine with AND. Unknown parameters are ignored. Inline, not shared:
 * OpenAPI describes query parameters one by one, not as a component.
 */
export const ListTradesQuery = Type.Object({
  symbol: Type.Optional(Type.String({
    description: 'Only trades whose symbol contains this text, anywhere in it, ignoring case; or, with symbolMatch=exact, ' +
      'only trades whose symbol is this text. Normalised like a symbol (trimmed, NFC, upper-cased); blank matches every trade.',
    examples: ['sf'],
  })),
  symbolMatch: Type.Optional(Type.Enum(SYMBOL_MATCHES, {
    default: DEFAULT_SYMBOL_MATCH,
    description: 'How symbol matches, exactly as written: contains (anywhere in the symbol) or exact (the whole symbol, ' +
      'so ms matches MS but not MSFT or MSTR). Both ignore case, as symbols are normalised. Without symbol it changes nothing.',
  })),
  side: Type.Optional(Type.String({
    description: 'Only Buy or only Sell trades, ignoring case and surrounding whitespace. Omitted: both sides.',
    examples: ['Buy'],
  })),
  status: Type.Optional(Type.String({
    description: 'Only Pending, only Executed or only Cancelled trades, ignoring case and surrounding whitespace. Omitted: every status. ' +
      'A trade without an execution time (Pending, or cancelled while Pending) never matches executedFrom or executedTo.',
    examples: ['Pending'],
  })),
  executedFrom: Type.Optional(QueryTimestamp('Only trades executed at or after this instant (inclusive).', '2026-01-01T00:00:00Z')),
  executedTo: Type.Optional(QueryTimestamp(
    'Only trades executed at or before this instant (inclusive). Must not be earlier than executedFrom.',
    '2026-01-31T23:59:59.999-05:00',
  )),
  sortBy: Type.Optional(Type.Enum(TRADE_SORT_FIELDS, {
    default: DEFAULT_TRADE_SORT.field,
    description: 'The field to sort by, exactly as written. Symbols sort by Unicode code point; quantity and price by exact ' +
      'numeric value. Ties are broken by executedAt, then bookingSequence, in the same direction. A trade without an execution ' +
      'time sorts before every executed trade in ascending order and after them in descending order, ordered among such trades ' +
      'by bookingSequence.',
  })),
  sortDirection: Type.Optional(Type.Enum(SORT_DIRECTIONS, {
    default: DEFAULT_TRADE_SORT.direction,
    description: 'asc or desc, exactly as written. desc lists the reverse of asc.',
  })),
})

const WholeNumberRule = 'Digits only: no sign, decimal point, exponent or spaces.'

/**
 * GET /trades/page query parameters: those of GET /trades, which mean the same there, and the
 * page. Inline, like ListTradesQuery.
 */
export const ListTradePageQuery = Type.Object({
  ...ListTradesQuery.properties,
  page: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_PAGE,
    default: 1,
    description: `The page to list, counting from 1. A page past the last is not an error: it has no items. ${WholeNumberRule}`,
  })),
  pageSize: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
    description: `Trades per page, at most ${String(MAX_PAGE_SIZE)}. ${WholeNumberRule}`,
  })),
})

export const TradePageResponse = Type.Object(
  {
    items: Type.Array(Type.Ref('Trade'), { description: 'The trades on this page, in the requested order; empty past the last page.' }),
    page: Type.Integer({ minimum: 1, description: 'The page number, as requested.' }),
    pageSize: Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, description: 'The page size, as requested.' }),
    totalCount: Type.Integer({ minimum: 0, description: 'Trades matching the filters, on every page. Counted with the page, so they agree.' }),
    totalPages: Type.Integer({ minimum: 0, description: 'Pages the matching trades fill: totalCount divided by pageSize, rounded up; 0 when none match.' }),
  },
  { $id: 'TradePage', description: 'One page of the trades GET /trades would list for the same query.' },
)

/** The only check made on a trade request before the domain sees it: the body is a JSON object. */
export const TradeRequestContainer = Type.Object({})

export const CancellationRequest = Type.Object(
  { reason: Type.String({ description: `Why the trade is cancelled: required, trimmed and NFC-normalised, 1 to ${String(CANCELLATION_REASON_MAX_LENGTH)} characters, no control or invisible characters.`, examples: ['Client withdrew the order'] }) },
  { $id: 'CancellationRequest', description: 'The actor (Admin) and the time are set by the server; members with other names are ignored.' },
)

export const CancellationResponse = Type.Object(
  {
    trade: Type.Ref('Trade', { description: 'The cancelled logical trade, as lists now show it: status Cancelled, updatedBy Admin, with the reason.' }),
    cancellationRecord: Type.Ref('Trade', { description: 'The physical cancellation record inserted: its own id, originalTradeId naming the trade, created by Admin. Lists never show it.' }),
  },
  { $id: 'Cancellation' },
)

export const AuditTradeSnapshot = Type.Object(
  {
    bookingSequence: Type.Integer(), id: Type.String(), symbol: Type.String(), side: Type.String(),
    quantity: Type.Number({ description: 'Exact, as stored.' }), price: Type.Number({ description: 'Exact, as stored.' }),
    executedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]), createdAt: Type.String({ format: 'date-time' }), updatedAt: Type.String({ format: 'date-time' }),
    quantityKey: Type.String({ description: 'The generated sort key, as it was at that write.' }), priceKey: Type.String({ description: 'As quantityKey, for the price.' }),
    status: Type.Union(TRADE_STATUSES.map((status) => Type.Literal(status))),
    createdBy: Type.Union(ACTORS.map((actor) => Type.Literal(actor))), updatedBy: Type.Union(ACTORS.map((actor) => Type.Literal(actor))),
    originalTradeId: Type.Union([Type.String(), Type.Null()]), cancellationReason: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'AuditTradeSnapshot', description: 'Every column of the physical trades row as it was at that write, as stored.' },
)

export const AuditEntry = Type.Object(
  {
    auditId: Type.Integer({ minimum: 1, description: 'Increases with every write: the order of the writes.' }),
    auditAction: Type.Union([Type.Literal('Inserted'), Type.Literal('Updated'), Type.Literal('Deleted')]),
    auditOn: Type.String({ format: 'date-time', description: `When the database wrote it. ${TIMESTAMP_FORMAT}` }),
    auditBy: Type.Literal('System'),
    trade: Type.Ref('AuditTradeSnapshot'),
  },
  { $id: 'AuditEntry' },
)

export const AuditPageResponse = Type.Object(
  {
    tradeId: Type.String({ description: 'The id asked for.' }),
    scope: Type.Union([Type.Literal('trade'), Type.Literal('logical')]),
    tradeIds: Type.Array(Type.String(), { description: 'The physical trades whose entries are listed: the one asked for, or, for scope=logical, the original and its cancellation record.' }),
    items: Type.Array(Type.Ref('AuditEntry'), { description: 'In auditId order; empty past the last page.' }),
    page: Type.Integer({ minimum: 1 }),
    pageSize: Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE }),
    totalCount: Type.Integer({ minimum: 0 }),
    totalPages: Type.Integer({ minimum: 0 }),
  },
  { $id: 'AuditPage', description: 'One page of a trade\'s audit history. Read only: the API never writes, changes or removes an audit entry.' },
)

/** GET /trades/{id}/audit query parameters. Inline, like ListTradesQuery. */
export const AuditQuery = Type.Object({
  scope: Type.Optional(Type.Enum(['trade', 'logical'], {
    default: 'trade',
    description: 'trade: the entries of this physical row only. logical: those of the logical trade, the original and its cancellation record, ' +
      'whichever of the two the id names. Exactly as written.',
  })),
  page: ListTradePageQuery.properties.page,
  pageSize: ListTradePageQuery.properties.pageSize,
})

export const SHARED_SCHEMAS = [CreateTradeRequest, TradeResponse, TradePageResponse, PositionResponse, Problem, CancellationRequest, CancellationResponse, AuditTradeSnapshot, AuditEntry, AuditPageResponse]
