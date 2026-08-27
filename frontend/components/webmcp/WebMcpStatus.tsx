'use client'

import { useOptionalWebMcpRegistry } from './WebMcpRegistry'

/**
 * Makes an invisible capability visible.
 *
 * Users told us they could not tell where to click or what to do next. WebMCP does not fix that
 * by itself — an agent the user does not know exists is no more discoverable than a button they
 * cannot find. So the count is shown, and it CHANGES as tools come and go: opening a trip takes
 * it from 2 to 4, which explains page-scoped tools better than a paragraph could.
 */
export default function WebMcpStatus({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const registry = useOptionalWebMcpRegistry()
  if (!registry) return null
  const setOpen = onOpenChange

  const { tools, supported } = registry
  const count = tools.length

  return (
    <div className="pointer-events-auto flex w-[min(22rem,100%)] flex-col items-end gap-2 text-xs">
      {open && (
        <div className="w-full overflow-hidden rounded-xl border border-white/15 bg-black/90 text-white/85 shadow-xl backdrop-blur">
          <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wider text-white/50">
              {supported ? 'Tools an agent can use here' : 'Agent tools unavailable'}
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close tool list"
              className="-mr-1 rounded px-1.5 py-0.5 text-white/50 transition hover:text-white/90"
            >
              ✕
            </button>
          </div>
          {/* Caps at 60% of the viewport and scrolls: 13 tools is already taller than a phone. */}
          <div className="max-h-[60dvh] overflow-y-auto overscroll-contain p-3">
            {supported ? (
              <>
                <ul className="space-y-2">
                  {tools.map((t) => (
                    <li key={t.name} className="leading-snug">
                      <div className="flex items-baseline justify-between gap-2">
                        <code className="text-[#E8D5B0]">{t.name}</code>
                        <span
                          className={[
                            'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                            t.readOnly ? 'bg-white/10 text-white/60' : 'bg-[#C9974E]/20 text-[#E8D5B0]',
                          ].join(' ')}
                        >
                          {t.readOnly ? 'reads' : 'changes'}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-white/55">{t.description}</p>
                    </li>
                  ))}
                  {count === 0 && <li className="text-white/50">No tools registered on this page yet.</li>}
                </ul>
                <p className="mt-3 border-t border-white/10 pt-2 text-[11px] text-white/50">
                  Unsure where to start? Just ask the agent what you can do here.
                </p>
              </>
            ) : (
              <>
                <p className="text-[11px] leading-relaxed text-white/65">
                  Astrail exposes its actions to AI agents through{' '}
                  <span className="text-[#E8D5B0]">WebMCP</span>. To use them, open this page in the{' '}
                  <strong className="text-white/85">ChatGPT desktop app&apos;s built-in browser</strong>, or in{' '}
                  <strong className="text-white/85">Chrome 149+</strong> with{' '}
                  <code className="break-all text-[#E8D5B0]">chrome://flags/#enable-webmcp-testing</code> enabled.
                </p>
                <p className="mt-2 text-[11px] text-white/45">
                  Everything on this page still works normally without it.
                </p>
              </>
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={supported ? `WebMCP active, ${count} tools` : 'WebMCP unavailable'}
        className={[
          'flex items-center gap-2 rounded-full border px-3 py-1.5 backdrop-blur transition',
          supported
            ? 'border-[#C9974E]/50 bg-black/60 text-[#E8D5B0] hover:border-[#C9974E]'
            : 'border-white/20 bg-black/50 text-white/60 hover:border-white/40',
        ].join(' ')}
      >
        <span
          aria-hidden
          className={[
            'inline-block h-1.5 w-1.5 rounded-full',
            supported ? 'bg-[#C9974E]' : 'bg-white/40',
          ].join(' ')}
        />
        {/* On a phone the trip panel is a full-width sheet, so a wide chip lands squarely on
            top of the day/leg counts. Compact to the number there and keep the words for
            screen readers; widen from sm: up where there is room beside the content. */}
        <span className="sm:hidden">{supported ? count : '—'}</span>
        <span className="hidden sm:inline">
          {supported ? `WebMCP active · ${count} tool${count === 1 ? '' : 's'}` : 'WebMCP unavailable'}
        </span>

      </button>

    </div>
  )
}
