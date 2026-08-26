import { describe, it, expect, vi } from 'vitest'
import { saveReelsTool } from '../tools/reels'
import { envelopeLength, OUTPUT_LIMIT } from '../fit'

const tool = (save = vi.fn().mockResolvedValue({})) => ({ spec: saveReelsTool({ save }), save })

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
    const out = await saveReelsTool({ save }).execute({
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
