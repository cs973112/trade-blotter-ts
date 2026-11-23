import type { AuditEntry } from '../api/contracts.ts'

/**
 * What an audit entry records, in words, with who did it. The roles are fixed by the lifecycle (labels
 * the server assigns; the application has no sign-in): a trade is booked by User, as Pending, and
 * executed by User; a cancellation record is created by Admin, and the cancellation's change to the
 * original is made by Admin; every audit entry itself is written by the database (System). The
 * words are worked out from the snapshot only; nothing here changes an entry.
 */
export function describeAuditEntry(entry: AuditEntry): string {
  const row = entry.trade
  const record = row.originalTradeId !== null
  switch (entry.auditAction) {
    case 'Inserted':
      return record
        ? `Cancellation record created by ${row.createdBy}, for trade ${row.originalTradeId}`
        : `Trade booked by ${row.createdBy} as ${row.status}`
    case 'Updated':
      if (record) return `Trade changed by ${row.updatedBy}`
      if (row.status === 'Cancelled') return `Trade cancelled by ${row.updatedBy}`
      return row.status === 'Executed' ? `Trade executed by ${row.updatedBy}` : `Trade changed by ${row.updatedBy}`
    case 'Deleted':
      return `Row deleted (last changed by ${row.updatedBy})`
  }
}

/** Whether an entry is of the cancellation record rather than the original trade. */
export function isCancellationRecordEntry(entry: AuditEntry): boolean {
  return entry.trade.originalTradeId !== null
}
