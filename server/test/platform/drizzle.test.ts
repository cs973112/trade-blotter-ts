import { asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'

/**
 * S6: the pinned Drizzle release runs on the built-in node:sqlite driver with no native addon,
 * keeps decimal text exact, and rolls back a synchronous transaction. A probe only: the
 * application schema, migrations and repository belong to the persistence phase.
 */
const probe = sqliteTable('probe', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  amount: text('amount').notNull(),
})

function openProbe() {
  const db = drizzle(':memory:')
  db.$client.exec('create table probe (sequence integer primary key autoincrement, amount text not null)')
  return db
}

describe('platform: Drizzle on node:sqlite', () => {
  it('inserts, returns and orders rows through typed queries, keeping decimal text exact', () => {
    const db = openProbe()

    const inserted = db.insert(probe).values([{ amount: '999999999999999.9999999999' }, { amount: '0.0000000001' }]).returning().all()
    const rows = db.select().from(probe).orderBy(asc(probe.sequence)).all()

    expect(inserted.map((row) => row.sequence)).toEqual([1, 2])
    expect(rows).toEqual([
      { sequence: 1, amount: '999999999999999.9999999999' },
      { sequence: 2, amount: '0.0000000001' },
    ])
    expect(db.select().from(probe).where(eq(probe.sequence, 2)).get()?.amount).toBe('0.0000000001')
    db.$client.close()
  })

  it('rolls back a synchronous transaction that throws', () => {
    const db = openProbe()

    expect(() => {
      db.transaction((tx) => {
        tx.insert(probe).values({ amount: '1' }).run()
        throw new Error('abort')
      })
    }).toThrow('abort')

    expect(db.select().from(probe).all()).toEqual([])
    db.$client.close()
  })
})
