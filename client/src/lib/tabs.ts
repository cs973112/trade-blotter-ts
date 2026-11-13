/** The page's tabs, in order. Trading is shown first. */
export const TABS = [
  { id: 'trading', label: 'Trading' },
  { id: 'details', label: 'Positions & Trade Details' },
  { id: 'history', label: 'Trade History' },
] as const

export type TabId = (typeof TABS)[number]['id']

/**
 * The tab a key moves to from this one, or undefined for a key that does not move: Right and Left
 * arrows to the next and previous (wrapping round), Home and End to the first and last.
 */
export function tabAfterKey(current: TabId, key: string): TabId | undefined {
  const index = TABS.findIndex((tab) => tab.id === current)
  const last = TABS.length - 1
  const target = key === 'ArrowRight' ? (index === last ? 0 : index + 1)
    : key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : key === 'Home' ? 0
        : key === 'End' ? last
          : undefined
  return target === undefined ? undefined : TABS[target]?.id
}
