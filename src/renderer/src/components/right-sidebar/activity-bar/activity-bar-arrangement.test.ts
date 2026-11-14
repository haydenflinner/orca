import { describe, expect, it } from 'vitest'
import { arrangeActivityItems, mergeActivityOrder } from './activity-bar-arrangement'

describe('activity bar arrangement', () => {
  const items = [{ id: 'explorer' }, { id: 'checks' }, { id: 'plugin-a' }]
  it('uses default order and appends new panels after saved items', () => {
    expect(arrangeActivityItems(items, []).map((item) => item.id)).toEqual([
      'explorer',
      'checks',
      'plugin-a'
    ])
    expect(
      arrangeActivityItems([...items, { id: 'plugin-b' }], ['checks', 'explorer', 'plugin-a']).map(
        (item) => item.id
      )
    ).toEqual(['checks', 'explorer', 'plugin-a', 'plugin-b'])
  })
  it('ignores removed and duplicate ids', () => {
    expect(
      arrangeActivityItems(items, ['removed', 'checks', 'checks']).map((item) => item.id)
    ).toEqual(['checks', 'explorer', 'plugin-a'])
  })
  it('retains unavailable slots across a reorder and restores them', () => {
    const saved = ['explorer', 'checks', 'plugin-a']
    const updated = mergeActivityOrder(saved, ['plugin-a', 'explorer'])
    expect(updated).toEqual(['plugin-a', 'checks', 'explorer'])
    expect(arrangeActivityItems(items, updated).map((item) => item.id)).toEqual([
      'plugin-a',
      'checks',
      'explorer'
    ])
  })
})
