import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StreamEvent } from '@/lib/trip/backend-types'
import { createGenerationStore } from '../generation'
import { getTripProgressTool, planTripFromReelsTool } from '../tools/generation'

/** A stream we drive by hand, so no EventSource and no real time is involved. */
function harness() {
  let emit: (e: StreamEvent) => void = () => {}
  let fail: () => void = () => {}
  let clock = 0
  const store = createGenerationStore(() => clock)
  const open = (onEvent: (e: StreamEvent) => void, onFail: () => void) => {
    emit = onEvent
    fail = onFail
    return { cancel: () => {} }
  }
  return {
    store,
    start: (id = 'trip-abc') => store.start(id, open),
    emit: (e: StreamEvent) => emit(e),
    fail: () => fail(),
    tick: (s: number) => { clock += s * 1000 },
  }
}

const stage = (s: string, msg: string): StreamEvent => ({ type: 'stage', stage: s as never, msg })

describe('generation store', () => {
  it('reports nothing before a run starts', () => {
    expect(createGenerationStore().snapshot()).toBeNull()
  })

  it('counts stages and tracks elapsed time', () => {
    const h = harness()
    h.start()
    h.emit(stage('create_trip', 'Creating'))
    h.emit(stage('scrape', 'Scraping'))
    h.tick(30)
    const s = h.store.snapshot()!
    expect(s.status).toBe('generating')
    expect(s.stagesSeen).toBe(2)
    expect(s.elapsedS).toBe(30)
  })

  it('does not count cache_hit as a pipeline step', () => {
    // It is optional and fires opportunistically; counting it makes progress jump around.
    const h = harness()
    h.start()
    h.emit(stage('scrape', 'Scraping'))
    h.emit(stage('cache_hit', 'Using cache'))
    expect(h.store.snapshot()!.stagesSeen).toBe(1)
  })

  it('does not double-count a repeated stage', () => {
    const h = harness()
    h.start()
    h.emit(stage('scrape', 'reel 1'))
    h.emit(stage('scrape', 'reel 2'))
    expect(h.store.snapshot()!.stagesSeen).toBe(1)
  })

  it('keeps the latest decision message — that is what the agent narrates', () => {
    const h = harness()
    h.start()
    h.emit({ type: 'decision', stage: 'dedup' as never, msg: 'kept 9 of 14 places' })
    expect(h.store.snapshot()!.lastMessage).toBe('kept 9 of 14 places')
  })

  it('goes complete on a result event', () => {
    const h = harness()
    h.start()
    h.emit({ type: 'result', content: '{}' })
    expect(h.store.snapshot()!.status).toBe('complete')
  })

  it('goes failed on an error event', () => {
    const h = harness()
    h.start()
    h.emit({ type: 'error', stage: 'scrape' as never, msg: 'apify timeout' })
    expect(h.store.snapshot()!.status).toBe('failed')
  })

  it('goes unknown when the stream dies — never an eternal "generating"', () => {
    const h = harness()
    h.start()
    h.fail()
    expect(h.store.snapshot()!.status).toBe('unknown')
  })
})

describe('waitForAdvance — the self-throttle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('resolves immediately when the run has already moved on', async () => {
    const h = harness()
    h.start()
    const v = h.store.snapshot()!.version
    h.emit(stage('scrape', 'Scraping'))
    await expect(h.store.waitForAdvance(v, 15_000)).resolves.toBeUndefined()
  })

  it('waits when nothing has changed, then resolves the moment it does', async () => {
    const h = harness()
    h.start()
    const v = h.store.snapshot()!.version
    let settled = false
    const p = h.store.waitForAdvance(v, 15_000).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBe(false)          // an eager agent simply waits
    h.emit(stage('scrape', 'Scraping'))
    await p
    expect(settled).toBe(true)
  })

  it('gives up after the timeout rather than hanging the tool call', async () => {
    // 15s sits inside any plausible tool timeout; blocking for the full 180s would not.
    const h = harness()
    h.start()
    const v = h.store.snapshot()!.version
    const p = h.store.waitForAdvance(v, 15_000)
    await vi.advanceTimersByTimeAsync(15_001)
    await expect(p).resolves.toBeUndefined()
  })

  it('never waits once the run is finished', async () => {
    const h = harness()
    h.start()
    h.emit({ type: 'result', content: '{}' })
    await expect(h.store.waitForAdvance(h.store.snapshot()!.version, 15_000)).resolves.toBeUndefined()
  })
})

describe('get_trip_progress', () => {
  it('guides the agent when nothing is running', async () => {
    const out = await getTripProgressTool(createGenerationStore()).execute({})
    expect(String(out)).toContain('plan_trip_from_reels')
  })

  it('narrates in the same words the user sees on screen', async () => {
    // The agent must speak the STAGE_LABEL string the page renders, never the raw enum —
    // otherwise chat says "create_trip" while the screen says "Creating your trip".
    const h = harness()
    h.start()
    h.emit(stage('create_trip', 'starting'))
    h.tick(71)
    const out = String(await getTripProgressTool(h.store, 0).execute({}))
    expect(out).toContain('generating · 71s')
    expect(out).toContain('Creating your trip')
    expect(out).not.toContain('create_trip')
    expect(out).toContain('last: starting')
  })

  it('hands the agent its next tool on completion', async () => {
    const h = harness()
    h.start()
    h.emit({ type: 'result', content: '{}' })
    const out = String(await getTripProgressTool(h.store, 0).execute({}))
    expect(out).toContain('complete')
    expect(out).toContain('next_tool: get_itinerary')
  })

  it('reports a failure with the stage it died on', async () => {
    const h = harness()
    h.start()
    h.emit({ type: 'error', stage: 'scrape' as never, msg: 'apify timeout' })
    const out = String(await getTripProgressTool(h.store, 0).execute({}))
    expect(out).toContain('failed')
    expect(out).toContain('Scraping Reels')
    expect(out).toContain('apify timeout')
  })
})

describe('plan_trip_from_reels', () => {
  const deps = (over = {}) => ({
    store: createGenerationStore(),
    create: vi.fn().mockResolvedValue('trip-123'),
    openStream: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    ...over,
  })

  it('asks the user before spending anything', async () => {
    const d = deps()
    await planTripFromReelsTool(d).execute({
      reel_urls: ['https://www.instagram.com/reel/Cabc123/'],
      start_date: '2026-03-03', end_date: '2026-03-07',
    })
    expect(d.confirm).toHaveBeenCalled()
    expect(d.create).toHaveBeenCalled()
  })

  it('spends NOTHING when the user declines', async () => {
    // This tool burns the user's one lifetime free trip plus real Apify/OpenAI credit.
    const d = deps({ confirm: vi.fn().mockResolvedValue(false) })
    const out = await planTripFromReelsTool(d).execute({
      reel_urls: ['https://www.instagram.com/reel/Cabc123/'],
      start_date: '2026-03-03', end_date: '2026-03-07',
    })
    expect(d.create).not.toHaveBeenCalled()
    expect(d.openStream).not.toHaveBeenCalled()
    expect(String(out)).toContain('declined')
  })

  it('shows the preferences text verbatim in the approval card', async () => {
    // A prompt-injected caption must not be able to steer a run the user never read.
    const d = deps()
    await planTripFromReelsTool(d).execute({
      reel_urls: ['https://www.instagram.com/reel/Cabc123/'],
      start_date: '2026-03-03', end_date: '2026-03-07',
      preferences: 'quiet places, no crowds',
    })
    expect(d.confirm.mock.calls[0][0]).toContain('quiet places, no crowds')
  })

  it('caps preferences length', async () => {
    const d = deps()
    await planTripFromReelsTool(d).execute({
      reel_urls: ['https://www.instagram.com/reel/Cabc123/'],
      start_date: '2026-03-03', end_date: '2026-03-07',
      preferences: 'x'.repeat(500),
    })
    expect((d.create.mock.calls[0][0].preferences as string).length).toBe(280)
  })

  it('rejects non-Instagram URLs before asking or spending', async () => {
    const d = deps()
    const out = await planTripFromReelsTool(d).execute({
      reel_urls: ['https://evil.example.com/x'],
      start_date: '2026-03-03', end_date: '2026-03-07',
    })
    expect(d.confirm).not.toHaveBeenCalled()
    expect(String(out)).toContain('No valid Instagram Reel URLs')
  })

  it('requires real dates', async () => {
    const d = deps()
    const out = await planTripFromReelsTool(d).execute({
      reel_urls: ['https://www.instagram.com/reel/Cabc123/'], start_date: 'soon', end_date: 'later',
    })
    expect(d.confirm).not.toHaveBeenCalled()
    expect(String(out)).toContain('YYYY-MM-DD')
  })

  it('rejects a reversed date range', async () => {
    const d = deps()
    const out = await planTripFromReelsTool(d).execute({
      reel_urls: ['https://www.instagram.com/reel/Cabc123/'],
      start_date: '2026-03-07', end_date: '2026-03-03',
    })
    expect(String(out)).toContain('before start_date')
  })

  it('returns structured next-step fields, not just prose', async () => {
    // Agents follow a structured next_tool far more reliably than an instruction in a sentence.
    const d = deps()
    const out = await planTripFromReelsTool(d).execute({
      reel_urls: ['https://www.instagram.com/reel/Cabc123/'],
      start_date: '2026-03-03', end_date: '2026-03-07',
    })
    const parsed = JSON.parse(String(out))
    expect(parsed).toMatchObject({ trip_id: 'trip-123', status: 'generating', next_tool: 'get_trip_progress' })
    expect(parsed.poll_after_seconds).toBeGreaterThan(0)
    expect(d.openStream).toHaveBeenCalledWith('trip-123')
  })
})
