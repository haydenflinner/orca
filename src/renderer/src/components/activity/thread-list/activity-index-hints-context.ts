import { createContext } from 'react'

/** Digit-jump numbering and chord for the activity list; absent where index jumps do not apply. */
export const ActivityIndexHintsContext = createContext<{
  indexByPaneKey: ReadonlyMap<string, number>
  modifierKeys: readonly string[]
} | null>(null)
