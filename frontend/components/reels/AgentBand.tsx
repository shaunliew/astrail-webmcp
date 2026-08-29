'use client'

import { useEffect, useRef, useState } from 'react'

/* AgentBand — the top band on a /app home that HAS content.
   ─────────────────────────────────────────────────────────────────────────────────────────
   The layout is the prompt. Asked "what can I do here?" on a populated /app, the agent
   answered by describing "Trails, New trail and Settings" — strings that live only in
   Sidebar.tsx and in no tool description anywhere. It read them off the RENDERED PAGE.
   Whatever the screen says loudest is what the agent says back, so on a page whose loudest
   block was a 24px "Your inspiration starts here" the agent described a filing cabinet.

   This band takes the top of the page and says the two things the agent should be repeating:
   what the pair can do next, counted against the user's real library, and one prompt that
   runs as written. It is deliberately NOT a hero — no brass box, no display type. It is a
   band the eye passes over on its way down, which is exactly how a page is read top-down.

   The caller owns the `registry.supported` gate (see TraysScreen). Rendering agent copy in a
   browser with no agent would tell a judge in Safari to talk to nobody.

   No chat panel here, on purpose: the agent lives in ChatGPT's browser, and every OpenAI
   reference app leaves it there. This band is the handoff, not a second front end. */

const BTN_COPY =
  'inline-flex min-h-9 flex-none items-center justify-center rounded-lg border border-[color:var(--brass-deep)] px-3 text-[12px] font-semibold uppercase tracking-wide text-[color:var(--brass-deep)] transition-colors hover:bg-[color:var(--brass-wash)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'

const COPIED = 'Copied. Paste it into ChatGPT with this page open.'
const COPY_FAILED = 'Copy did not work in this browser — select the prompt and copy it yourself.'

/**
 * What the pair can do next, in terms of the library the user actually has.
 *
 * `savedCount === null` means the count is NOT KNOWN — the saved-reel fetch lives in the
 * parent, and an in-flight read, a failed read and a genuinely empty library all arrive there
 * as an empty array. The sentence drops the number rather than print a "0 saved reels" that a
 * judge with a full library would immediately catch us out on.
 */
function capabilitySentence(savedCount: number | null): string {
  const library =
    savedCount === null
      ? 'your saved reels'
      : `your ${savedCount} saved reel${savedCount === 1 ? '' : 's'}`
  return `With this page open, ChatGPT can read ${library}, save new links, and plan a trip from them — you approve every step here.`
}

export default function AgentBand({
  savedCount,
  prompt,
}: {
  /**
   * Saved reels the agent can already read, or null when there is no number worth printing —
   * a library the parent has not finished reading, or one with nothing in it yet.
   */
  savedCount: number | null
  /** Runnable as written — the caller owns it so there is ONE source of the demo dates. */
  prompt: string
}) {
  // Idle until the user presses Copy. The live region below is rendered either way, so
  // reporting the result never moves the page that sits under this band.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  // Mounted-guard, with the cleanup that makes it real: the parent unmounts this band the
  // moment the home resolves to CONFIRMED-empty (the invitation owns that case), which can
  // land while a clipboard promise is still in flight. Mirrors TraysScreen's activeRef.
  const activeRef = useRef(true)
  useEffect(() => {
    activeRef.current = true
    return () => { activeRef.current = false }
  }, [])

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt)
      if (activeRef.current) setCopyState('copied')
    } catch {
      // Clipboard access is permission-gated and absent entirely over plain http. The prompt is
      // rendered as selectable text for exactly this case — say so rather than fail silently.
      if (activeRef.current) setCopyState('failed')
    }
  }

  return (
    <section
      aria-label="Astrail agent"
      className="mb-5 rounded-xl border border-[color:var(--line-soft)] bg-[color:var(--surface-2)] px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="flex-none text-[11px] font-semibold uppercase tracking-wide text-[color:var(--brass-deep)]">
          Agent-ready
        </span>
        <p className="min-w-0 flex-1 text-[13px] leading-[1.5] text-[color:var(--text-muted)]">
          {capabilitySentence(savedCount)}
        </p>
      </div>

      <div className="mt-2.5 flex flex-wrap items-start gap-3">
        {/* Selectable text, not an input: it is the fallback when the clipboard is unavailable,
            and it must never look like one more field waiting to be filled in. */}
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--surface-1)] px-3 py-2 font-mono text-[12px] leading-[1.5] text-[color:var(--text)]">
          {prompt}
        </pre>
        <button type="button" onClick={() => void copyPrompt()} className={BTN_COPY}>
          Copy prompt
        </button>
      </div>

      {/* Present from first paint, empty until there is something to say: a live region that
          appears only on success announces nothing, and one that appears at all shoves the
          whole page down by a line the first time you touch the band at the top of it. */}
      <p role="status" aria-live="polite" className="mt-2 min-h-[1.125rem] text-[12px] text-[color:var(--text-muted)]">
        {copyState === 'copied' ? COPIED : copyState === 'failed' ? COPY_FAILED : ''}
      </p>
    </section>
  )
}
