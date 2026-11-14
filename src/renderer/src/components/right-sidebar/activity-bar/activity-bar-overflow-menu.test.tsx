// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { TopActivityOverflowMenu, type ActivityBarItem } from './activity-bar-buttons'

const items: ActivityBarItem[] = [
  { id: 'explorer', title: 'Explorer', icon: () => null, shortcut: '' },
  { id: 'plugin:test:panel', pluginKey: 'test', title: 'Plugin', icon: () => null, shortcut: '' }
]

afterEach(() => {
  cleanup()
  useAppStore.setState({ activityBarOrder: [], activityBarHidden: [] })
})

it('hides and restores an overflowed panel through its context menu', () => {
  render(
    <TopActivityOverflowMenu
      items={[items[1]]}
      arrangementItems={items}
      activeTab="explorer"
      onSelect={vi.fn()}
      activityBarPosition="top"
      onChangeActivityBarPosition={vi.fn()}
    />
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More sidebar tabs' }), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Plugin' }), {
    clientX: 40,
    clientY: 20
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
  expect(useAppStore.getState().activityBarHidden).toEqual(['plugin:test:panel'])
  fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Plugin' }), {
    clientX: 40,
    clientY: 20
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show Plugin' }))
  expect(useAppStore.getState().activityBarHidden).toEqual([])
})
