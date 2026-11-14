import { expect, it, vi } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'
import { persistedUIWriteFieldsToWireUpdate } from './persisted-ui-write-baseline'

it('restores the saved activity order and hidden panels from the write payload', () => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn().mockResolvedValue(undefined) } } })
  try {
    const payload = persistedUIWriteFieldsToWireUpdate({
      activityBarOrder: ['explorer', 'plugin:test:panel'],
      activityBarHidden: ['plugin:test:panel']
    })
    const store = createUIStore()
    store.getState().hydratePersistedUI(makePersistedUI(payload))
    expect(store.getState().activityBarOrder).toEqual(['explorer', 'plugin:test:panel'])
    expect(store.getState().activityBarHidden).toEqual(['plugin:test:panel'])
  } finally {
    vi.unstubAllGlobals()
  }
})
