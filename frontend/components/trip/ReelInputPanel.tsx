'use client'

import { useState } from 'react'

export type TripFormValues = {
  reelUrls: string[]
  startDate: string
  endDate: string
  budget: string
  origin: string
  preferences: string
}

type Props = {
  onSubmit: (values: TripFormValues) => void
  isLoading: boolean
}

export default function ReelInputPanel({ onSubmit, isLoading }: Props) {
  const [reelInput, setReelInput] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [budget, setBudget] = useState('')
  const [origin, setOrigin] = useState('')
  const [preferences, setPreferences] = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const reelUrls = reelInput
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean)
      .slice(0, 5)
    if (reelUrls.length === 0) return
    onSubmit({ reelUrls, startDate, endDate, budget, origin, preferences })
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-5 w-full max-w-xl"
    >
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-[color:var(--starlight)]/50 font-[family-name:var(--font-geist)] uppercase tracking-wider">
          Instagram Reel URLs (up to 5, one per line)
        </label>
        <textarea
          value={reelInput}
          onChange={(e) => setReelInput(e.target.value)}
          placeholder={"https://www.instagram.com/reel/...\nhttps://www.instagram.com/reel/..."}
          rows={4}
          required
          className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm text-[color:var(--starlight)] placeholder:text-white/20 font-[family-name:var(--font-geist)] resize-none focus:outline-none focus:border-white/30"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-[color:var(--starlight)]/50 font-[family-name:var(--font-geist)] uppercase tracking-wider">
            Start date
          </label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            required
            className="bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm text-[color:var(--starlight)] font-[family-name:var(--font-geist)] focus:outline-none focus:border-white/30"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-[color:var(--starlight)]/50 font-[family-name:var(--font-geist)] uppercase tracking-wider">
            End date
          </label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            required
            className="bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm text-[color:var(--starlight)] font-[family-name:var(--font-geist)] focus:outline-none focus:border-white/30"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-[color:var(--starlight)]/50 font-[family-name:var(--font-geist)] uppercase tracking-wider">
            Flying from
          </label>
          <input
            type="text"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder="Kuala Lumpur"
            required
            className="bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm text-[color:var(--starlight)] placeholder:text-white/20 font-[family-name:var(--font-geist)] focus:outline-none focus:border-white/30"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-[color:var(--starlight)]/50 font-[family-name:var(--font-geist)] uppercase tracking-wider">
            Budget (USD)
          </label>
          <input
            type="text"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="$2000"
            className="bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm text-[color:var(--starlight)] placeholder:text-white/20 font-[family-name:var(--font-geist)] focus:outline-none focus:border-white/30"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-[color:var(--starlight)]/50 font-[family-name:var(--font-geist)] uppercase tracking-wider">
          Preferences (optional)
        </label>
        <input
          type="text"
          value={preferences}
          onChange={(e) => setPreferences(e.target.value)}
          placeholder="No spicy food, love nature, travelling with a toddler..."
          className="bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm text-[color:var(--starlight)] placeholder:text-white/20 font-[family-name:var(--font-geist)] focus:outline-none focus:border-white/30"
        />
      </div>

      <button
        type="submit"
        disabled={isLoading}
        className="w-full py-3 rounded-lg bg-[color:var(--starlight)] text-[color:var(--void)] text-sm font-medium font-[family-name:var(--font-geist)] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isLoading ? 'Building your itinerary…' : 'Plan my trip'}
      </button>
    </form>
  )
}
