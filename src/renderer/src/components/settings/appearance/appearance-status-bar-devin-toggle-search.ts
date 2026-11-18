import type { StatusBarItem } from '../../../../../shared/ui-chrome/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export function getDevinStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'devin',
    title: translate('auto.components.settings.appearance.search.devinUsage', 'Devin usage'),
    description: translate(
      'auto.components.settings.appearance.search.devinUsageDescription',
      'Show Devin plan quota in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.devin', 'devin'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.quota', 'quota'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.cognition', 'cognition')
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.devinToggleDescription',
      'Show Devin daily and weekly plan quota from the Devin CLI sign-in.'
    )
  }
}
