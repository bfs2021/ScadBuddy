import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group'
import type { ColourSwatch } from '../colours'
import { swatchBackground } from '../params'

/** Past this many colours, the picker offers a search. */
const SEARCH_FROM = 24
/** The grid's columns: the arrow keys move up and down by this many. */
const COLUMNS = 4

/** The issue's copy (#6258), shown in the picker while a colour in it is greyed. */
export const GREYED_NOTE =
  "Some colours can't go together. Each print is made from one kind of plastic, and a few colours only come in one kind. Greyed colours don't match what you've picked. Choose one anyway and we'll suggest matches."

export interface ColourPickerProps {
  /** The parameter's label, as the customer reads it. */
  label: string
  /** The colours the customer may pick for this part: one per colour, whatever its material. */
  swatches: readonly ColourSwatch[]
  /** Whether the customer picked this part; false while the shop's choice stands. */
  picked: boolean
  /** The colour the row shows (`ColourSwatch.key`): the pick, else the shop's choice. */
  shown: string | undefined
  /** The greyed colours (`ColourSwatch.key`), each with why: picking one changes another part. */
  greyed?: ReadonlyMap<string, string>
  /** The id of the row's button, so focus can come back to it. */
  triggerId?: string
  /** Whether focus goes elsewhere once the grid closes (to the swap offer), not back to the row. */
  holdFocus?: boolean
  /** A colour picked, or undefined to go back to the shop's choice. */
  onChange: (next: ColourSwatch | undefined) => void
}

/**
 * #6152, #6258 — one colour part of a design: a row with the colour on it, which opens a
 * grid of swatches. A colour in two materials is one swatch, named by its colour: the
 * material is never shown (`colours.ts`). A colour that does not go with the other picks
 * stays in the grid, greyed, still focusable and pickable; its description says which
 * part it changes. Styled with the theme's tokens only.
 */
export function ColourPicker({ label, swatches, picked, shown, greyed, triggerId, holdFocus, onChange }: ColourPickerProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const grid = useRef<HTMLDivElement>(null)
  const current = swatches.find((swatch) => swatch.key === shown?.toLowerCase())
  const anyGreyed = swatches.some((swatch) => greyed?.has(swatch.key))

  const visible = swatches.filter((swatch) => search.trim() === '' || swatch.name.toLowerCase().includes(search.trim().toLowerCase()))

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }
    const step = steps[event.key]
    if (step === undefined) return
    const items = Array.from(grid.current?.querySelectorAll<HTMLButtonElement>('[data-slot="toggle-group-item"]') ?? [])
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = items[Math.min(items.length - 1, Math.max(0, (at < 0 ? 0 : at) + (at < 0 ? 0 : step)))]
    if (next) {
      // Before the item's own roving focus, which moves one step only.
      event.preventDefault()
      event.stopPropagation()
      next.focus()
    }
  }

  return (
    <div className="min-w-0">
      <p className="mb-1.5 block p-0 font-semibold" id={`${id}-label`}>
        {label}
      </p>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id={triggerId}
          type="button"
          aria-labelledby={`${id}-label ${id}-value`}
          className="flex min-h-12 w-full items-center gap-3 rounded-[10px] border-[1.5px] border-input bg-background px-3.5 py-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span
            className="size-7 flex-none rounded-full border border-foreground/25"
            style={{ background: current ? swatchBackground(current.filament) : 'transparent' }}
            aria-hidden="true"
          />
          <span id={`${id}-value`} className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {current ? current.name : 'Choose a colour'}
          </span>
        </PopoverTrigger>
        <PopoverContent
          className="w-[min(22rem,calc(100vw-32px))]"
          align="start"
          aria-label={`Colours for ${label}`}
          onCloseAutoFocus={(event) => {
            if (holdFocus) event.preventDefault()
          }}
        >
          {anyGreyed && <p className="m-0 text-sm text-muted-foreground">{GREYED_NOTE}</p>}
          {swatches.length > SEARCH_FROM && (
            <input
              type="search"
              aria-label="Find a colour"
              placeholder="Find a colour"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="min-h-10 w-full rounded-md border border-input bg-background px-3"
            />
          )}
          <ToggleGroup
            ref={grid}
            type="single"
            aria-label={label}
            loop={false}
            onKeyDownCapture={move}
            // The shop's choice shows as picked until the customer picks (#6144); tapping
            // it empties the group, which keeps the shop's choice.
            value={current?.key ?? ''}
            onValueChange={(key) => {
              setOpen(false)
              onChange(key === '' ? undefined : swatches.find((swatch) => swatch.key === key))
            }}
            className="grid max-h-[50vh] w-full grid-cols-4 gap-2 overflow-y-auto p-0.5"
          >
            {visible.map((swatch) => {
              const why = greyed?.get(swatch.key)
              return (
                <ToggleGroupItem
                  key={swatch.key}
                  value={swatch.key}
                  aria-label={swatch.name}
                  aria-describedby={why ? `${id}-why-${swatch.key.replace('#', '')}` : undefined}
                  data-greyed={why ? '' : undefined}
                  className="group/swatch flex h-auto min-w-0 flex-col items-center gap-1 rounded-md p-1 text-center text-xs font-normal whitespace-normal focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-transparent data-[state=on]:ring-2 data-[state=on]:ring-primary"
                >
                  <span
                    className="relative size-10 rounded-full border border-foreground/25 group-data-[greyed]/swatch:opacity-35 group-data-[greyed]/swatch:grayscale-[60%]"
                    style={{ background: swatchBackground(swatch.filament) }}
                    aria-hidden="true"
                  />
                  <span className="w-full leading-tight [overflow-wrap:anywhere] group-data-[greyed]/swatch:text-muted-foreground">{swatch.name}</span>
                  {why && (
                    <span id={`${id}-why-${swatch.key.replace('#', '')}`} className="sr-only">
                      {why}
                    </span>
                  )}
                </ToggleGroupItem>
              )
            })}
            {visible.length === 0 && <p className="col-span-4 m-0 text-sm text-muted-foreground">No colour matches.</p>}
          </ToggleGroup>
          {picked && (
            <button
              type="button"
              className="self-start text-sm underline"
              onClick={() => {
                setOpen(false)
                onChange(undefined)
              }}
            >
              Use our pick
            </button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
