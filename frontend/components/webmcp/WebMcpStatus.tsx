'use client'

import { useState } from 'react'
import { useOptionalWebMcpRegistry } from './WebMcpRegistry'

/**
 * Makes an invisible capability visible.
 *
 * Users told us they could not tell where to click or what to do next. WebMCP does not fix that
 * by itself — an agent the user does not know exists is no more discoverable than a button they
 * cannot find. So the count is shown, and it CHANGES as tools come and go: opening a trip takes
 * it from 2 to 4, which explains page-scoped tools better than a paragraph could.
 */
export default function WebMcpStatus() {
  const registry = useOptionalWebMcpRegistry()
  const [open, setOpen] = useState(false)
  if (!registry) return null

  const { tools, supported } = registry
  const count = tools.length

  return (
    <div className="fixed bottom-4 right-4 z-40 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
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
        {supported ? `WebMCP active · ${count} tool${count === 1 ? '' : 's'}` : 'WebMCP unavailable'}
      </button>

      {open && (
        <div className="mt-2 w-80 rounded-xl border border-white/15 bg-black/85 p-3 text-white/85 shadow-xl backdrop-blur">
          {supported ? (
            <>
              <p className="mb-2 text-[11px] uppercase tracking-wider text-white/50">
                Tools an agent can use on this page
              </p>
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
              <p className="mb-2 text-[11px] uppercase tracking-wider text-white/50">
                Agent tools are not available in this browser
              </p>
              <p className="text-[11px] leading-relaxed text-white/65">
                Astrail exposes its actions to AI agents through{' '}
                <span className="text-[#E8D5B0]">WebMCP</span>. To use them, open this page in the{' '}
                <strong className="text-white/85">ChatGPT desktop app&apos;s built-in browser</strong>, or in{' '}
                <strong className="text-white/85">Chrome 149+</strong> with{' '}
                <code className="text-[#E8D5B0]">chrome://flags/#enable-webmcp-testing</code> enabled.
              </p>
              <p className="mt-2 text-[11px] text-white/45">
                Everything on this page still works normally without it.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
