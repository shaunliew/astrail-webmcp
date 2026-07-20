'use client'

import { useMemo } from 'react'
import { countryDisplayLabel, type CountryTray } from '@/lib/reels/organize'
import VerifiedPlacesMap from './VerifiedPlacesMap'

export default function CountryTrays({
  trays, selectedPlaceIds, onToggle, onPlan,
}: {
  trays: CountryTray[]
  selectedPlaceIds: string[]
  onToggle: (placeId: string) => void
  onPlan: () => void
}) {
  const verifiedPlaces = useMemo(() => trays.flatMap((tray) => tray.places), [trays])

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-4xl flex-col gap-6 bg-[var(--void)] p-6">
      <header className="flex flex-col gap-2">
        <p className="type-label text-[10px] uppercase tracking-[0.2em] text-[var(--brass-bright)]">Your grounded places</p>
        <h1 className="type-display text-3xl text-[var(--starlight)]">Choose the places to carry forward</h1>
        <p className="type-body text-sm text-[var(--muted)]">Every pin is tied to a grounded place and its source Reel.</p>
      </header>
      <VerifiedPlacesMap places={verifiedPlaces} />
      <div className="flex flex-col gap-4">
        {trays.map((tray) => (
          <section key={tray.country_code} className="surface flex flex-col gap-3 p-4">
            <h2 className="type-display text-xl text-[var(--starlight)]">{countryDisplayLabel(tray)}</h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {tray.places.map((place) => (
                <li key={place.place_id} className="rounded-lg border border-[var(--line)] p-3">
                  <label className="flex cursor-pointer gap-3">
                    <input type="checkbox" aria-label={`Select ${place.name}`} checked={selectedPlaceIds.includes(place.place_id)} onChange={() => onToggle(place.place_id)} className="mt-1 h-5 w-5 shrink-0 accent-[var(--brass)]" />
                    <span className="min-w-0 flex-1">
                      <span className="type-body flex items-center gap-2 text-sm text-[var(--starlight)]"><span data-testid="place-pin" aria-hidden className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--brass-bright)]" />{place.name}</span>
                      <span className="type-evidence mt-1 block text-[10px] text-[var(--faint)]">{place.lat.toFixed(4)}, {place.lng.toFixed(4)}</span>
                      <span className="type-body mt-2 block text-xs text-[var(--muted)]">“{place.evidence_quote}”</span>
                      {place.source_reel_url ? <a href={place.source_reel_url} target="_blank" rel="noreferrer" className="type-label mt-2 inline-block text-[10px] uppercase tracking-wide text-[var(--brass-bright)] underline">Source Reel</a> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="sticky bottom-4 flex justify-end">
        <button type="button" onClick={onPlan} disabled={!selectedPlaceIds.length} className="type-label min-h-11 rounded-lg border border-[var(--brass)] bg-[var(--brass-soft)] px-5 text-xs uppercase tracking-wide text-[var(--starlight)] disabled:cursor-not-allowed disabled:opacity-40">Plan this trip</button>
      </div>
    </main>
  )
}
