import { describe, it, expect, vi } from 'vitest'
import { getRememberedPreferencesTool, formatRememberedPreferences } from '../tools/preferences'
import { fitsBudget } from '../fit'
import type { MemoryFact, SettingsPreferencesResponse } from '@/lib/trip/backend-types'

const fact = (memory: string, i = 1): MemoryFact =>
  ({ id: `m${i}`, memory, created_at: '2026-08-01T00:00:00Z', source: 'mem0' })

const res = (over: Partial<SettingsPreferencesResponse> = {}): SettingsPreferencesResponse =>
  ({ status: 'ok', facts: [], ...over })

describe('get_remembered_preferences', () => {
  it('reads back what Astrail remembers', async () => {
    const out = String(await getRememberedPreferencesTool({
      load: async () => res({ facts: [fact('Prefers walkable days'), fact('Likes ramen', 2)] }),
    }).execute({}))
    expect(out).toContain('Prefers walkable days')
    expect(out).toContain('Likes ramen')
  })

  /* THE THREE ENDINGS THAT MUST NOT COLLAPSE INTO ONE.

     "You have nothing saved", "memory is switched off" and "we could not read it" are different
     answers, and the backend keeps `status` separate from `facts` precisely so a caller cannot
     merge them (main.py's get_settings_preferences). An agent that says "you have no saved
     preferences" during an outage tells the user something false about their own account, and
     the user's reasonable next move — re-stating preferences they already gave — is the one
     thing that would then overwrite nothing and teach them the feature is broken. */
  it('does not report an outage as an empty memory', async () => {
    const out = String(await getRememberedPreferencesTool({
      load: async () => res({ status: 'unavailable' }),
    }).execute({}))
    expect(out).toMatch(/could not reach/i)
    expect(out, 'an unreachable store was reported as nothing saved').not.toMatch(/nothing remembered yet/i)
  })

  it('does not report a switched-off feature as an empty memory', async () => {
    const out = String(await getRememberedPreferencesTool({
      load: async () => res({ status: 'disabled' }),
    }).execute({}))
    expect(out).toMatch(/switched off/i)
    expect(out, 'a disabled feature was reported as nothing saved').not.toMatch(/nothing remembered yet/i)
  })

  it('says plainly when there is genuinely nothing, and why', async () => {
    const out = String(await getRememberedPreferencesTool({ load: async () => res() }).execute({}))
    expect(out).toMatch(/nothing remembered yet/i)
    // The empty state has to teach the way OUT of itself, or it reads as a broken feature.
    expect(out).toMatch(/states one while planning/i)
  })

  it('never claims these are what the next trip will use', async () => {
    /* They are a superset, differently ordered: recall is a semantic top_k=10 search that runs
       only when the user states no preferences for that trip. The backend's own docstring says
       not to describe this endpoint as "exactly what recall will use". */
    const out = String(await getRememberedPreferencesTool({
      load: async () => res({ facts: [fact('Prefers walkable days')] }),
    }).execute({}))
    expect(out).toMatch(/only when the user states none of their own/i)
  })

  it('fits the output budget even with a pathological number of memories', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      fact(`Remembered preference number ${i} with enough prose to be realistic about length`, i))
    const out = formatRememberedPreferences(res({ facts: many }))
    expect(fitsBudget(out), `serialized envelope was ${out.length} raw chars`).toBe(true)
    expect(out, 'truncated with no signal that anything was dropped').toMatch(/more/i)
  })

  it('is a read, and says its content is untrusted', () => {
    const spec = getRememberedPreferencesTool({ load: async () => res() })
    expect(spec.annotations?.readOnlyHint).toBe(true)
    // The stored text can reach mem0 through the agent's own `preferences` argument, which it may
    // have lifted off a Reel caption. User-stated is not the same as user-typed.
    expect(spec.annotations?.untrustedContentHint).toBe(true)
  })

  it('takes no arguments — one user can never read another', () => {
    const spec = getRememberedPreferencesTool({ load: async () => res() })
    expect(spec.inputSchema?.properties ?? {}).toEqual({})
    // The backend derives the user from the token (guardrails #5/#6); a user_id parameter here
    // would be an invitation the API would refuse anyway.
    expect(JSON.stringify(spec.inputSchema)).not.toMatch(/user_?id/i)
  })

  it('surfaces a reader that throws rather than crashing the tool call', async () => {
    const load = vi.fn().mockRejectedValue(new Error('network'))
    await expect(getRememberedPreferencesTool({ load }).execute({})).rejects.toThrow()
    // Deliberate: the registration layer turns a throw into an isError envelope carrying the
    // message. Swallowing it here would report "nothing remembered" for a failed read — the
    // exact collapse the three endings above exist to prevent.
  })
})
