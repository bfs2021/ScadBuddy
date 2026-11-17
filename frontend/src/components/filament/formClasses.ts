/** A native `<select>` drawn like the shadcn `Input`, for the Filament tabs' small forms. */
export const SELECT_CLASS =
  'h-8 min-w-0 rounded-lg border border-input bg-transparent px-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30'

/** A table's head cell and body cell: dense, left-aligned; numbers add `text-right tabular-nums`. */
export const TH = 'px-2 py-1.5 font-medium'
export const TD = 'px-2 py-1.5'

/** A date and time as a person reads it; the ISO string stays in `<time dateTime>`. */
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
