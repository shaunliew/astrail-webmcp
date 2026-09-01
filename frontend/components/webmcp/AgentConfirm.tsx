'use client'

import { useState } from 'react'
import type { PendingPrompt } from './WebMcpRegistry'
import { useOptionalWebMcpRegistry } from './WebMcpRegistry'

/**
 * How much the field will hold, matching the ceiling a stated preference already has.
 *
 * A courtesy, not the enforcement: `plan_trip_from_reels` trims and caps whatever this answers
 * with before it goes anywhere, because a card is not the only thing that can call it. Stopping
 * the typing is only so the limit is met while the user can still see what they wrote.
 */
const MAX_OVERRIDE = 280

/**
 * The approval card an agent cannot skip.
 *
 * `plan_trip_from_reels` spends the user's ONE lifetime free trip plus real Apify and OpenAI
 * credit. Reversible actions get an undo; irreversible or costly ones get this. The summary is
 * rendered as TEXT, verbatim, so a prompt-injected Reel caption cannot dress itself up as
 * interface chrome or hide what is about to happen.
 */
export default function AgentConfirm() {
  const registry = useOptionalWebMcpRegistry()
  const pending = registry?.pending
  if (!pending) return null
  // Its own component, because the field is state and a hook cannot live past the return above.
  if (pending.kind === 'prompt') return <PreferenceCard pending={pending} />
  const { summary, resolve } = pending

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Astrail wants your approval"
      className="fixed inset-x-0 bottom-20 z-50 mx-auto w-[min(28rem,calc(100%-2rem))] rounded-xl border border-[#C9974E]/60 bg-black/90 p-4 text-sm text-white/90 shadow-2xl backdrop-blur"
    >
      <p className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-[#E8D5B0]">
        <span aria-hidden className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#C9974E]" />
        Astrail wants to
      </p>
      {/* Deliberately plain text, never innerHTML — this string can carry caption-derived content. */}
      <p className="whitespace-pre-line leading-relaxed text-white/85">{summary}</p>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => resolve(true)}
          className="flex-1 rounded-lg bg-[#C9974E] px-3 py-2 font-medium text-black transition hover:bg-[#E8D5B0]"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => resolve(false)}
          className="flex-1 rounded-lg border border-white/25 px-3 py-2 text-white/80 transition hover:border-white/50"
        >
          Not now
        </button>
      </div>
    </div>
  )
}

/**
 * The same approval, for the one case where Astrail is about to lean on what it remembers.
 *
 * A remembered preference is a DEFAULT, not a mandate — preferences change per trip. Naming what
 * Astrail holds and offering only Approve left the user two answers to a three-answer question:
 * accept it, or abandon the trip. The field is the third.
 *
 * It starts EMPTY, and blank means "use what you remember". The remembered text is mem0 prose
 * that reached the store through the agent's own `preferences` argument; seeding it into the
 * input would let it be submitted back as the user's own stated words without anyone typing them
 * — and the backend treats a stated preference as explicit and remembers it.
 *
 * The chrome below is a deliberate copy of the card above rather than a shared wrapper. That card
 * is the gate six tools depend on, and the point of this change was that it does not move.
 */
function PreferenceCard({ pending }: { pending: PendingPrompt }) {
  const { summary, prompt, resolve } = pending
  const [text, setText] = useState('')
  // The value the answer actually carries, so the button can name what pressing it does. A
  // button reading "Use what it remembers" above a filled field describes the opposite.
  const override = text.trim().slice(0, MAX_OVERRIDE) || null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Astrail wants your approval"
      className="fixed inset-x-0 bottom-20 z-50 mx-auto w-[min(28rem,calc(100%-2rem))] rounded-xl border border-[#C9974E]/60 bg-black/90 p-4 text-sm text-white/90 shadow-2xl backdrop-blur"
    >
      <p className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-[#E8D5B0]">
        <span aria-hidden className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#C9974E]" />
        Astrail wants to
      </p>
      {/* Deliberately plain text, never innerHTML — this string can carry caption-derived content. */}
      <p className="whitespace-pre-line leading-relaxed text-white/85">{summary}</p>
      <label className="mt-3 block">
        <span className="mb-1 block text-[11px] uppercase tracking-wider text-white/55">{prompt.label}</span>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={prompt.placeholder}
          maxLength={MAX_OVERRIDE}
          className="w-full rounded-lg border border-white/25 bg-white/5 px-3 py-2 text-white/90 outline-none transition placeholder:text-white/35 focus:border-[#C9974E]"
        />
      </label>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => resolve({ approved: true, text: override })}
          className="flex-1 rounded-lg bg-[#C9974E] px-3 py-2 font-medium text-black transition hover:bg-[#E8D5B0]"
        >
          {override ? 'Use this instead' : 'Use what it remembers'}
        </button>
        <button
          type="button"
          /* `text: null`, whatever is in the field. Declining is a refusal to start, not a
             preference stated on the way out — and a declined run must carry nothing forward. */
          onClick={() => resolve({ approved: false, text: null })}
          className="flex-1 rounded-lg border border-white/25 px-3 py-2 text-white/80 transition hover:border-white/50"
        >
          Not now
        </button>
      </div>
    </div>
  )
}
