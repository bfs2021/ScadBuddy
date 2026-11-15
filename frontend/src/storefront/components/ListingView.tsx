import { useEffect, useId, useMemo, useRef, useState, type ElementType } from 'react'
import { Button } from '../../components/ui/button'
import type { Listing, ParamValue } from '../api/client'
import { colourName, colourPlan, colourSwatches, greyedReason, pickOutcome, swapText, type PartChange } from '../colours'
import { listingUnavailable } from '../params'
import { ParamField, type ColourPart } from './ParamField'

export type ParamValues = Record<string, ParamValue>

export interface ListingViewProps {
  listing: Listing
  /** Only the values the visitor set: a field with none shows the shop's choice. */
  values: ParamValues
  onChange: (name: string, next: ParamValue | undefined) => void
  /** The title's heading level: 1 on the public page, 2 inside the back office's preview. */
  headingLevel?: 1 | 2
}

/** A greyed colour the visitor picked, waiting for an answer (#6258). */
type Offer = { name: string; colour: string; changes: PartChange[] } | { name: string; colour: string; changes: null }

/**
 * #5282 (spec 2026-11-02 §5.3, §5.4) — one listing as a visitor sees it: its title, its
 * description, its pictures, and a field for each parameter the customer may change. The
 * public page (`pages/CustomizePage.tsx`) mounts it, and so does the back office's
 * Storefront page as its live preview, so the shop sees the customer's form. It fetches
 * nothing and is styled with the theme's tokens only.
 *
 * #6258: the colour picks fix one material (`colours.ts`). A colour that does not go with
 * the other picks is greyed; picking it asks first whether to change the other parts to
 * their closest colours in the new material.
 *
 * Everything the shop typed (title, description, captions, labels) renders as React text,
 * never as HTML (spec §5.8).
 */
export function ListingView({ listing, values, onChange, headingLevel = 1 }: ListingViewProps) {
  const Heading: ElementType = headingLevel === 1 ? 'h1' : 'h2'
  const id = useId()
  const params = Object.entries(listing.params)
  const plan = useMemo(() => colourPlan(listing, values), [listing, values])
  const [offer, setOffer] = useState<Offer | null>(null)
  const offerButton = useRef<HTMLButtonElement>(null)
  const triggerId = (name: string) => `${id}-colour-${name}`

  useEffect(() => {
    if (!offer) return
    // After the picker's popover gives focus back to its row on close.
    const timer = setTimeout(() => offerButton.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [offer])

  const closeOffer = (name: string) => {
    setOffer(null)
    document.getElementById(triggerId(name))?.focus()
  }

  const colourPart = (name: string): ColourPart | undefined => {
    const param = listing.params[name]
    if (!param || param.kind !== 'choice' || !param.colour) return undefined
    const swatches = colourSwatches(param, listing.colours)
    const greyed = new Map<string, string>()
    for (const swatch of swatches) {
      const why = greyedReason(listing, pickOutcome(listing, values, name, swatch.colour))
      if (why) greyed.set(swatch.key, why)
    }
    return {
      swatches,
      shown: plan.shown[name],
      greyed,
      triggerId: triggerId(name),
      holdFocus: offer?.name === name,
      onPick: (next) => {
        setOffer(null)
        if (next === undefined) return onChange(name, undefined)
        const outcome = pickOutcome(listing, values, name, next.colour)
        if (outcome.kind === 'fits') return onChange(name, next.colour)
        setOffer({ name, colour: next.colour, changes: outcome.kind === 'swap' ? outcome.changes : null })
      },
    }
  }

  const accept = (current: Offer) => {
    if (current.changes === null) return
    onChange(current.name, current.colour)
    for (const change of current.changes) onChange(change.name, change.to)
    closeOffer(current.name)
  }

  return (
    <article className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-col gap-2">
        <Heading className="sf-layered m-0 text-[clamp(1.8rem,6vw,2.6rem)] leading-[1.05] font-extrabold tracking-tight [overflow-wrap:anywhere]">
          {listing.title}
        </Heading>
        {listing.description && <p className="m-0 whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">{listing.description}</p>}
      </header>
      {listing.media.length > 0 && (
        <ul className="m-0 flex list-none gap-2 overflow-x-auto p-0" aria-label="Pictures">
          {listing.media.map((media) => (
            <li key={media.url} className="shrink-0">
              <figure className="m-0 flex w-36 flex-col gap-1">
                {media.kind === 'video' ? (
                  <video src={media.url} controls muted playsInline className="aspect-square w-36 rounded-md bg-muted object-cover" />
                ) : (
                  <img src={media.url} alt={media.caption} className="aspect-square w-36 rounded-md bg-muted object-cover" />
                )}
                {media.caption && <figcaption className="text-xs text-muted-foreground">{media.caption}</figcaption>}
              </figure>
            </li>
          ))}
        </ul>
      )}
      {listingUnavailable(listing) && (
        <p className="m-0 font-medium text-destructive" role="status">
          This design cannot be ordered right now.
        </p>
      )}
      {params.length > 0 ? (
        <form className="grid gap-[18px]" aria-label="Customize" onSubmit={(event) => event.preventDefault()}>
          {params.map(([name, param]) => (
            <div key={name} className="grid min-w-0 gap-3">
              <ParamField
                param={param}
                value={values[name]}
                filaments={listing.colours}
                colour={colourPart(name)}
                onChange={(next) => onChange(name, next)}
              />
              {offer?.name === name && (
                <div
                  role="alertdialog"
                  aria-labelledby={`${id}-offer`}
                  className="grid gap-3 rounded-[10px] border-[1.5px] border-primary bg-muted/40 p-3.5"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation()
                      closeOffer(name)
                    }
                  }}
                >
                  <p id={`${id}-offer`} className="m-0 [overflow-wrap:anywhere]">
                    {offer.changes === null
                      ? `${colourName(listing, offer.colour)} can't be used with this design right now. Choose another colour.`
                      : swapText(listing, offer.colour, offer.changes)}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {offer.changes !== null && (
                      <Button ref={offerButton} type="button" className="min-h-11 px-4" onClick={() => accept(offer)}>
                        Use {colourName(listing, offer.colour)}
                      </Button>
                    )}
                    <Button
                      ref={offer.changes === null ? offerButton : undefined}
                      type="button"
                      variant="outline"
                      className="min-h-11 px-4"
                      onClick={() => closeOffer(name)}
                    >
                      Keep my colours
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </form>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">This design is made as shown.</p>
      )}
    </article>
  )
}
