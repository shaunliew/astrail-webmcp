'use client'

import { useMemo, useState } from 'react'
import { countryDisplayLabel, type CountryTray } from '@/lib/reels/organize'
import VerifiedPlacesMap from './VerifiedPlacesMap'

/* Map-first tray: the collection over a full-bleed map (DESIGN.md — the map is the
   canvas). A retractable paper sheet (bottom on mobile / left rail on desktop, tap the
   grip to collapse) holds the grounded places grouped by country, each selectable; a FAB
   plans a trip from the selection. Full-bleed (fixed) so it escapes the /app sidebar shell.

   NOTE: grouped by country (SavedReelPlaceProof has country_code/name, not place_type —
   the mockup's Places/Food category chips need a backend place_type; deferred). */

export default function CountryTrays({
  trays,
  selectedPlaceIds,
  maxSelected,
  onToggle,
  onPlan,
}: {
  trays: CountryTray[]
  selectedPlaceIds: string[]
  maxSelected?: number
  onToggle: (placeId: string) => void
  onPlan: () => void
}) {
  const verifiedPlaces = useMemo(() => trays.flatMap((tray) => tray.places), [trays])
  const [collapsed, setCollapsed] = useState(false)
  const total = verifiedPlaces.length
  const countries = trays.length
  const cap = maxSelected ?? Infinity
  const atMax = selectedPlaceIds.length >= cap

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-[color:var(--night-900)]">
      {/* Full-bleed map canvas */}
      <VerifiedPlacesMap places={verifiedPlaces} className="absolute inset-0 h-full w-full" />

      {/* Floating collection title over the map */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-wrap items-center gap-3 p-4 md:pl-[460px]">
        <span className="rounded-full bg-[color:var(--brass-bright)] px-4 py-2 text-[14px] font-medium text-[color:var(--night-900)] shadow-[0_2px_12px_rgba(0,0,0,0.35)]">
          Your grounded places
        </span>
        <span className="text-[13px] text-[color:var(--starlight-70)]">
          {total} {total === 1 ? 'place' : 'places'} · {countries} {countries === 1 ? 'country' : 'countries'}
        </span>
      </div>

      {/* Retractable sheet — bottom on mobile, left rail on desktop. Tap the grip to collapse. */}
      <section
        className={`absolute z-20 flex flex-col border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] text-[color:var(--text)] shadow-[0_1px_2px_rgba(28,23,16,0.10),0_-10px_44px_rgba(0,0,0,0.4)] transition-transform duration-300 ease-out inset-x-0 bottom-0 max-h-[70dvh] rounded-t-2xl md:inset-x-auto md:left-4 md:top-4 md:bottom-4 md:max-h-none md:w-[420px] md:rounded-2xl ${
          collapsed ? 'translate-y-[calc(100%-3.25rem)] md:translate-y-0 md:-translate-x-[calc(100%+1rem)]' : ''
        }`}
      >
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex min-h-[3.25rem] shrink-0 items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-[color:var(--brass-deep)]"
        >
          <span aria-hidden className="h-1 w-9 rounded-full bg-[color:var(--paper-line-2)]" />
          <span className="sr-only">{collapsed ? 'Show places' : 'Hide places'}</span>
        </button>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-24">
          {trays.map((tray) => (
            <div key={tray.country_code} className="mb-6">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="font-display text-[18px] font-medium text-[color:var(--text)]">{countryDisplayLabel(tray)}</h2>
                <span className="text-[13px] text-[color:var(--text-faint)]">{tray.places.length}</span>
              </div>
              <ul className="flex flex-col gap-2">
                {tray.places.map((place) => {
                  const on = selectedPlaceIds.includes(place.place_id)
                  return (
                    <li key={place.place_id}>
                      <label
                        className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${
                          on ? 'border-[color:var(--accent)]' : 'border-[color:var(--line-soft)] hover:bg-[color:var(--surface-2)]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          aria-label={`Select ${place.name}`}
                          checked={on}
                          disabled={!on && atMax}
                          onChange={() => onToggle(place.place_id)}
                          className="mt-0.5 h-5 w-5 shrink-0 accent-[color:var(--brass-deep)] disabled:cursor-not-allowed disabled:opacity-40"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2 text-[15px] font-medium text-[color:var(--text)]">
                            <span data-testid="place-pin" aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full bg-[color:var(--brass-deep)]" />
                            {place.name}
                          </span>
                          <span className="mt-0.5 block font-mono text-[11px] text-[color:var(--text-faint)]">
                            {place.lat.toFixed(4)}, {place.lng.toFixed(4)}
                          </span>
                          <span className="mt-1.5 block text-[13px] text-[color:var(--text-muted)]">“{place.evidence_quote}”</span>
                          {place.source_reel_url ? (
                            <a
                              href={place.source_reel_url}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-2 inline-block text-[11px] font-semibold uppercase tracking-wide text-[color:var(--brass-deep)] underline underline-offset-2"
                            >
                              Source Reel
                            </a>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>

        {/* FAB pinned at the sheet bottom */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-stretch gap-2 p-4">
          {maxSelected && atMax ? (
            <p className="self-center rounded-full bg-[color:var(--surface-2)] px-3 py-1 text-[12px] text-[color:var(--text-muted)]">
              Up to {maxSelected} places per trip
            </p>
          ) : null}
          <button
            type="button"
            onClick={onPlan}
            disabled={!selectedPlaceIds.length}
            className="pointer-events-auto flex min-h-[52px] w-full items-center justify-center rounded-full border border-[color:var(--accent)] bg-[color:var(--accent)] px-5 text-[14px] font-medium text-[color:var(--accent-text)] shadow-[0_10px_28px_-8px_rgba(138,90,24,0.55)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:border-dashed disabled:border-[color:var(--line-soft)] disabled:bg-transparent disabled:text-[color:var(--text-muted)]"
          >
            {selectedPlaceIds.length ? `Plan this trip · ${selectedPlaceIds.length}${maxSelected ? ` / ${maxSelected}` : ''}` : 'Select places to plan this trip'}
          </button>
        </div>
      </section>
    </div>
  )
}
