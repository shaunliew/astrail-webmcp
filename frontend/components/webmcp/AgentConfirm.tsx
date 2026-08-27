'use client'

import { useOptionalWebMcpRegistry } from './WebMcpRegistry'

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
  if (!registry?.pending) return null
  const { summary, resolve } = registry.pending

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
