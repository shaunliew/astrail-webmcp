import type { ToolSpec } from '../types'
import { normalizeReelUrl } from '@/lib/trip/parse-inspiration'

/**
 * Reel ingestion — the friction this whole project started from.
 *
 * The manual flow is: copy an Instagram URL, switch tabs, paste, repeat. `save_reels` collapses
 * that to one sentence. Whether the agent sourced those URLs by reading other open tabs or the
 * user pasted them into chat makes NO difference here — the tool receives an array either way.
 * That is deliberate: it means the cross-tab experiment is a demo question, not a build risk.
 */

export type SaveReelsDeps = {
  save: (url: string) => Promise<unknown>
}

const MAX_REELS = 5

export function saveReelsTool(deps: SaveReelsDeps): ToolSpec {
  return {
    name: 'save_reels',
    description:
      'Saves Instagram Reel or post URLs to the user\'s Astrail library so their places can be extracted. Accepts up to 5 at once. Only instagram.com reel/reels/p/tv links are accepted; anything else is rejected before any request is made. Saving is cheap and reversible, so no confirmation is needed. Report per-URL results to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          description: 'Instagram Reel URLs, up to 5.',
          items: { type: 'string' },
        },
      },
      required: ['urls'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute: async (args) => {
      const raw = Array.isArray(args.urls) ? args.urls : []
      if (raw.length === 0) return 'No URLs given. Paste one or more Instagram Reel links.'
      if (raw.length > MAX_REELS) return `Too many at once — ${MAX_REELS} is the limit. Got ${raw.length}.`

      const results: string[] = []
      for (const candidate of raw) {
        const url = typeof candidate === 'string' ? normalizeReelUrl(candidate) : null
        if (!url) {
          // Reject BEFORE any request. A tool that fetches a URL an agent lifted from a caption
          // is an SSRF primitive by construction; this regex is the trust boundary.
          results.push(`✗ ${String(candidate).slice(0, 60)} — not an Instagram Reel link`)
          continue
        }
        try {
          await deps.save(url)
          results.push(`✓ ${url}`)
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'failed'
          results.push(`✗ ${url} — ${msg.slice(0, 80)}`)
        }
      }
      const saved = results.filter((r) => r.startsWith('✓')).length
      return `Saved ${saved} of ${raw.length}.\n${results.join('\n')}`
    },
  }
}
