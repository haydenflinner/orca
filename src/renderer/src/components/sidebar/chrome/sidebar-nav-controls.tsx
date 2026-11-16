import React from 'react'
import { EyeOff } from 'lucide-react'
import { ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

export function HideSidebarMenu({ onHide }: { onHide: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <ContextMenuContent>
      <ContextMenuItem onSelect={onHide}>
        <EyeOff className="size-3.5" />
        {t('auto.components.sidebar.SidebarNav.d599269755', 'Hide from sidebar')}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/** Hover-revealed eye inside a nav row; hidden items restore via Settings → Appearance → Sidebar. */
export function SidebarNavHideButton({ onHide }: { onHide: () => void }): React.JSX.Element {
  const t = useTranslate()
  const label = t('auto.components.sidebar.SidebarNav.d599269755', 'Hide from sidebar')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="muted-field-icon"
          size="icon-xs"
          className="size-5"
          onClick={(event) => {
            event.stopPropagation()
            onHide()
          }}
          aria-label={label}
        >
          <EyeOff className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** Positions a hide affordance over a nav row's trailing edge only while the row is hovered or focused. */
export const SIDEBAR_NAV_TRAILING_HOVER_CLASS =
  'pointer-events-none absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
