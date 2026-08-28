import { describe, it, expect, vi } from 'vitest'
import { saveReelsTool } from '../tools/reels'
import { envelopeLength, OUTPUT_LIMIT } from '../fit'

/** `save` resolves to a saved reel: the tool reads its id and analysis_status to decide what to
 *  send for extraction. `analyze` is the second half — queuing place extraction — which the app's
 *  own form has always done and the tool used not to. */
const tool = (
  save = vi.fn().mockResolvedValue({ id: 'sr_1', analysis_status: 'not_analyzed' }),
  analyze = vi.fn().mockResolvedValue({ job_id: 'job_1' }),
) => ({ spec: saveReelsTool({ save, analyze }), save, analyze })

describe('save_reels', () => {
  it('saves valid Instagram Reel URLs', async () => {
    const { spec, save } = tool()
    const out = await spec.execute({ urls: ['https://www.instagram.com/reel/Cabc123/'] })
    expect(save).toHaveBeenCalledTimes(1)
    expect(String(out)).toContain('Saved 1 of 1')
  })

  it('accepts the /p/ and /reels/ forms too', async () => {
    const { spec, save } = tool()
    await spec.execute({
      urls: ['https://instagram.com/p/Cxyz789/', 'https://www.instagram.com/reels/Cdef456/'],
    })
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('REJECTS a non-Instagram URL before making any request', async () => {
    // The trust boundary. A tool that fetches a URL an agent lifted out of a caption is an
    // SSRF/exfiltration primitive; the validation must run before `save` is ever reached.
    const { spec, save } = tool()
    const out = await spec.execute({ urls: ['https://evil.example.com/steal'] })
    expect(save).not.toHaveBeenCalled()
    expect(String(out)).toContain('not an Instagram Reel link')
  })

  it('is not fooled by a lookalike host', async () => {
    const { spec, save } = tool()
    await spec.execute({ urls: ['https://instagram.com.evil.example/reel/Cabc123/'] })
    expect(save).not.toHaveBeenCalled()
  })

  it('saves the good ones and reports the bad ones, rather than failing the batch', async () => {
    const { spec, save } = tool()
    const out = await spec.execute({
      urls: ['https://www.instagram.com/reel/Cgood11/', 'not-a-url'],
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(String(out)).toContain('Saved 1 of 2')
    expect(String(out)).toContain('✓')
    expect(String(out)).toContain('✗')
  })

  it('surfaces a per-URL failure without throwing out of the tool', async () => {
    const save = vi.fn().mockRejectedValue(new Error('already saved'))
    const out = await saveReelsTool({ save, analyze: vi.fn() }).execute({
      urls: ['https://www.instagram.com/reel/Cabc123/'],
    })
    expect(String(out)).toContain('already saved')
    expect(String(out)).toContain('Saved 0 of 1')
  })

  it('enforces the 5-reel cap the backend also enforces', async () => {
    const { spec, save } = tool()
    const six = Array.from({ length: 6 }, (_, i) => `https://www.instagram.com/reel/Cabc${i}/`)
    const out = await spec.execute({ urls: six })
    expect(save).not.toHaveBeenCalled()
    expect(String(out)).toContain('5 is the limit')
  })

  it('guides the user when given nothing', async () => {
    const out = await tool().spec.execute({ urls: [] })
    expect(String(out)).toContain('Paste one or more')
  })

  it('stays inside the output budget at the cap', async () => {
    const { spec } = tool()
    const five = Array.from({ length: 5 }, (_, i) => `https://www.instagram.com/reel/Clongcode${i}/`)
    const out = await spec.execute({ urls: five })
    expect(envelopeLength(String(out))).toBeLessThanOrEqual(OUTPUT_LIMIT)
  })
})

import { listSavedReelsTool, type SavedReelSummary } from '../tools/reels'

const reel = (
  url: string, places: [string, string][], caption: string | null = null, hasCurrentCache = false,
): SavedReelSummary => ({
  url, caption, status: 'analyzed', hasCurrentCache,
  places: places.map(([name, country]) => ({ name, country })),
})

const listTool = (reels: SavedReelSummary[]) => listSavedReelsTool({ load: async () => reels })

describe('list_saved_reels', () => {
  it('unblocks planning from an existing library — the whole point of the tool', async () => {
    // Without this, plan_trip_from_reels needs URLs the agent has no way to obtain, so it would
    // have to ask the user to paste links they had ALREADY saved.
    const out = String(await listTool([
      reel('https://www.instagram.com/reel/Ca/', [['Senso-ji', 'Japan']], 'hidden Tokyo spots'),
    ]).execute({}))
    expect(out).toContain('instagram.com/reel/Ca')
    expect(out).toContain('Senso-ji')
  })

  it('groups by the country places were verified in', async () => {
    const out = String(await listTool([
      reel('https://www.instagram.com/reel/Ca/', [['Senso-ji', 'Japan'], ['Shibuya', 'Japan']]),
      reel('https://www.instagram.com/reel/Cb/', [['Hoi An', 'Vietnam']]),
    ]).execute({}))
    expect(out).toContain('Japan 2 places')
    expect(out).toContain('Vietnam 1 places')
  })

  it('filters by country', async () => {
    const out = String(await listTool([
      reel('https://www.instagram.com/reel/Ca/', [['Senso-ji', 'Japan']]),
      reel('https://www.instagram.com/reel/Cb/', [['Hoi An', 'Vietnam']]),
    ]).execute({ country: 'Vietnam' }))
    expect(out).toContain('Hoi An')
    expect(out).not.toContain('Senso-ji')
  })

  it('says so plainly when a filter matches nothing', async () => {
    const out = String(await listTool([reel('https://www.instagram.com/reel/Ca/', [['Senso-ji', 'Japan']])])
      .execute({ country: 'Peru' }))
    expect(out).toContain('No saved reels with places in "Peru"')
  })

  it('truncates long captions rather than blowing the output budget', async () => {
    const out = String(await listTool([
      reel('https://www.instagram.com/reel/Ca/', [['A', 'Japan']], 'x'.repeat(300)),
    ]).execute({}))
    expect(out).not.toContain('x'.repeat(100))
  })

  it('distinguishes "none saved" from "could not read"', async () => {
    // A failed read must never render as an empty library — the agent would tell the user to
    // start over when in fact they have a full tray.
    const empty = String(await listTool([]).execute({}))
    expect(empty).toContain('No saved reels yet')

    const broken = listSavedReelsTool({ load: async () => { throw new Error('not signed in') } })
    const out = String(await broken.execute({}))
    expect(out).toContain('Could not read')
    expect(out.toLowerCase()).toContain('do not tell the user they have none')
  })

  it('caps the list and stays inside the output budget', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      reel(`https://www.instagram.com/reel/Clong${i}/`, [[`A Place With A Long Name ${i}`, 'Japan']], 'a caption here'))
    const out = String(await listTool(many).execute({}))
    expect(out).toContain('more')
    expect(envelopeLength(out)).toBeLessThanOrEqual(OUTPUT_LIMIT)
  })
})


/* Saving used to stop at "recorded". The reel then sat `not_analyzed` with no places, so the
   agent could save three reels and still have nothing to plan a trip from — which is exactly what
   happened in testing. The app's own form (SavedReelsFlow) always called startOrganize after
   captureSavedReel; the tool simply never did. */
describe('save_reels: extraction', () => {
  const URLS = ['https://www.instagram.com/reel/Ca1/', 'https://www.instagram.com/reel/Cb2/']

  it('queues extraction for what it just saved', async () => {
    const save = vi.fn()
      .mockResolvedValueOnce({ id: 'sr_1', analysis_status: 'not_analyzed' })
      .mockResolvedValueOnce({ id: 'sr_2', analysis_status: 'not_analyzed' })
    const { spec, analyze } = tool(save)
    const out = await spec.execute({ urls: URLS })

    // ONE call for the batch. The backend permits a single active organize job per user, so a
    // per-reel loop would 409 on the second reel.
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(analyze).toHaveBeenCalledWith(['sr_1', 'sr_2'])
    expect(String(out)).toContain('Extracting places from 2')
  })

  it('never re-extracts a reel that is already organized', async () => {
    // Saving is an upsert, so re-adding a known reel returns it organized. Re-analysing would
    // spend an Apify run and a slot of the daily cap to recompute what is already stored.
    const save = vi.fn()
      .mockResolvedValueOnce({ id: 'sr_1', analysis_status: 'organized' })
      .mockResolvedValueOnce({ id: 'sr_2', analysis_status: 'not_analyzed' })
    const { spec, analyze } = tool(save)
    await spec.execute({ urls: URLS })
    expect(analyze).toHaveBeenCalledWith(['sr_2'])
  })

  it('says so plainly when everything was already analysed', async () => {
    const save = vi.fn().mockResolvedValue({ id: 'sr_1', analysis_status: 'organized' })
    const { spec, analyze } = tool(save)
    const out = await spec.execute({ urls: [URLS[0]] })
    expect(analyze).not.toHaveBeenCalled()
    expect(String(out)).toContain('already analysed')
  })

  it('reports a failed queue WITHOUT claiming the save failed', async () => {
    // The two outcomes are separate: the reels are saved and the Library can organise them later.
    // Collapsing them would tell the user to re-save reels that are already there.
    const analyze = vi.fn().mockRejectedValue(new Error('postgrest unavailable'))
    const { spec } = tool(undefined, analyze)
    const out = await spec.execute({ urls: [URLS[0]] })
    expect(String(out)).toContain('Saved 1 of 1')
    expect(String(out)).toContain('extraction did not start')
  })

  it('does not call an in-flight extraction a failure', async () => {
    // The backend allows one active organize job per user, so overlapping a running one 409s.
    // Extraction IS happening — reporting "did not start" would send the user to retry work
    // already in progress.
    const analyze = vi.fn().mockRejectedValue(new Error('One of those Reels is already being organized. Wait for it to finish.'))
    const { spec } = tool(undefined, analyze)
    const out = String(await spec.execute({ urls: [URLS[0]] }))
    expect(out).toContain('Saved 1 of 1')
    expect(out).toContain('already being extracted')
    expect(out).not.toContain('did not start')
  })

  it('does not queue extraction when nothing saved', async () => {
    const { spec, analyze } = tool()
    await spec.execute({ urls: ['https://evil.example.com/x'] })
    expect(analyze).not.toHaveBeenCalled()
  })
})


describe('save_reels: re-pasting a reel already in the library', () => {
  const URL = 'https://www.instagram.com/reel/Ca1/'

  it('says so rather than reporting it as a new save', async () => {
    // An agent reporting "Saved 3" when two were already there misstates what it did, and sends
    // the user looking for reels that never arrived.
    const save = vi.fn().mockResolvedValue({
      id: 'sr_1', analysis_status: 'organized',
      created_at: '2026-08-01T10:00:00Z', updated_at: '2026-08-27T09:00:00Z',
    })
    const out = String(await saveReelsTool({ save, analyze: vi.fn() }).execute({ urls: [URL] }))
    expect(out).toContain('already in your library')
  })

  it('stays quiet for a genuinely new save', async () => {
    const t = '2026-08-27T10:00:00Z'
    const save = vi.fn().mockResolvedValue({ id: 'sr_1', analysis_status: 'not_analyzed', created_at: t, updated_at: t })
    const out = String(await saveReelsTool({ save, analyze: vi.fn() }).execute({ urls: [URL] }))
    expect(out).not.toContain('already in your library')
  })

  it('does not guess when the backend sent no timestamps', async () => {
    // Absence of evidence is not evidence of a duplicate: claiming one would be worse than
    // saying nothing.
    const save = vi.fn().mockResolvedValue({ id: 'sr_1', analysis_status: 'not_analyzed' })
    const out = String(await saveReelsTool({ save, analyze: vi.fn() }).execute({ urls: [URL] }))
    expect(out).not.toContain('already in your library')
  })
})

describe('list_saved_reels — which reels are already read', () => {
  /* `has_current_cache` is the app's own signal that a reel's extraction matches the extractor
     version the pipeline will ask for. Surfacing it lets the agent tell the user what a plan will
     actually involve BEFORE they approve it. */
  const ca = 'https://www.instagram.com/reel/Ca/'
  const cb = 'https://www.instagram.com/reel/Cb/'

  it('marks the reels Astrail has already read', async () => {
    const out = String(await listTool([
      reel(ca, [['Senso-ji', 'Japan']], null, true),
      reel(cb, [['Shibuya', 'Japan']], null, false),
    ]).execute({}))
    const lineA = out.split('\n').find((l) => l.includes('/Ca/')) ?? ''
    const lineB = out.split('\n').find((l) => l.includes('/Cb/')) ?? ''
    expect(lineA).toMatch(/already read/i)
    expect(lineB).not.toMatch(/already read/i)
  })

  it('counts them in the header so the agent can answer "what will this cost"', async () => {
    const out = String(await listTool([
      reel(ca, [['Senso-ji', 'Japan']], null, true),
      reel(cb, [['Shibuya', 'Japan']], null, true),
    ]).execute({}))
    expect(out.split('\n')[0]).toMatch(/2 already read/i)
  })

  it('omits the header count entirely when none are read', async () => {
    // "0 already read" is noise on every line of a fresh library.
    const out = String(await listTool([reel(ca, [['Senso-ji', 'Japan']])]).execute({}))
    expect(out.split('\n')[0]).not.toMatch(/already read/i)
  })
})
