import { computed, ref } from 'vue'

/**
 * Which of a grid's columns are shown. Essential columns (what identifies a row) are always shown;
 * the others can be hidden and shown again, one by one. Columns keep their order whatever is
 * hidden. Show all shows every column, those hidden by default included; Restore puts back the
 * defaults, which may hide some.
 */

export interface ChoosableColumn {
  readonly key: string
  readonly label: string
  /** Always shown: it identifies the row. */
  readonly essential?: boolean
  /** Hidden until chosen. */
  readonly hiddenByDefault?: boolean
}

/** The keys shown by default: every column not hidden by default, and every essential one. */
export function defaultShown(columns: readonly ChoosableColumn[]): ReadonlySet<string> {
  return new Set(columns.filter((column) => column.essential === true || column.hiddenByDefault !== true).map((column) => column.key))
}

/** The keys shown after showing or hiding one column. Essential and unknown columns are left as they are. */
export function withColumn(shown: ReadonlySet<string>, columns: readonly ChoosableColumn[], key: string, show: boolean): ReadonlySet<string> {
  const column = columns.find((candidate) => candidate.key === key)
  if (column === undefined || column.essential === true) return shown
  const next = new Set(shown)
  if (show) next.add(key)
  else next.delete(key)
  return next
}

/** Every column's key: what Show all shows. */
export function allShown(columns: readonly ChoosableColumn[]): ReadonlySet<string> {
  return new Set(columns.map((column) => column.key))
}

/** The columns shown, in the grid's own order. */
export function shownColumns<C extends ChoosableColumn>(columns: readonly C[], shown: ReadonlySet<string>): C[] {
  return columns.filter((column) => column.essential === true || shown.has(column.key))
}

export function useColumnVisibility<C extends ChoosableColumn>(columns: readonly C[]) {
  const shown = ref<ReadonlySet<string>>(defaultShown(columns))
  const visibleColumns = computed(() => shownColumns(columns, shown.value))
  const atDefaults = computed(() => {
    const defaults = defaultShown(columns)
    return defaults.size === shown.value.size && [...defaults].every((key) => shown.value.has(key))
  })
  /** Every column shown: Show all has nothing to do. */
  const allVisible = computed(() => visibleColumns.value.length === columns.length)

  function isShown(key: string): boolean {
    return shownColumns(columns, shown.value).some((column) => column.key === key)
  }

  function setShown(key: string, show: boolean): void {
    shown.value = withColumn(shown.value, columns, key, show)
  }

  function restoreDefaults(): void {
    shown.value = defaultShown(columns)
  }

  /** Shows every column, each in its place in the grid's order. Nothing changes when all are shown. */
  function showAll(): void {
    if (allVisible.value) return
    shown.value = allShown(columns)
  }

  return { columns, shown, visibleColumns, atDefaults, allVisible, isShown, setShown, restoreDefaults, showAll }
}

export type ColumnVisibility = ReturnType<typeof useColumnVisibility>
