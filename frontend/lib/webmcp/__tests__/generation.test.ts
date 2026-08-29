import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StreamEvent } from '@/lib/trip/backend-types'
import { ERROR_CODE_RATE_LIMITED, ERROR_CODE_TRIAL_EXHAUSTED } from '@/lib/trip/backend-types'
import { ApiError } from '@/lib/trip/api'
import { createGenerationStore, readResultVerdict } from '../generation'
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

  it('a decision does NOT become the stage now running', () => {
    /* The late stages run concurrently, so a completion for one arrives while others are still
       working. get_trip_progress presents `stage` as "the stage now running" in so many words;
       letting a finished stage overwrite it makes the agent announce summarising as live while
       transport is mid-flight, and produces self-contradictions like
       `stage "Writing your day summaries" · last: Wrote summaries for 3 days`. */
    const h = harness()
    h.start()
    h.emit(stage('transport', 'Working out how to get between stops'))
    h.emit({ type: 'decision', stage: 'summarize' as never, msg: 'Wrote summaries for 3 days' })
    const s = h.store.snapshot()!
    expect(s.stage).toBe('transport')
    expect(s.lastMessage).toBe('Wrote summaries for 3 days')
  })

  it('a decision still advances version so an awaiting poll wakes', () => {
    const h = harness()
    h.start()
    const before = h.store.snapshot()!.version
    h.emit({ type: 'decision', stage: 'hotels' as never, msg: 'Found 3 places to stay' })
    expect(h.store.snapshot()!.version).toBeGreaterThan(before)
  })

  it('goes complete on a result event', () => {
    const h = harness()
    h.start()
    h.emit({ type: 'result', content: '{}' })
    expect(h.store.snapshot()!.status).toBe('complete')
  })

  it('treats a result carrying {error} as FAILED, not complete', () => {
    /* A leased backend failure emits exactly this: a terminal result whose payload carries an
       error, with NO preceding `error` event (runner.py:154 -> streaming.py:53). The status in
       here is what every consumer reads — get_trip_progress included — so calling it complete
       makes the agent tell the user a dead run is ready. Fixing only the page left the two
       disagreeing: page failed, agent complete. */
    const h = harness()
    h.start()
    h.emit({ type: 'result', content: JSON.stringify({ error: 'lease lost' }) })
    expect(h.store.snapshot()!.status).toBe('failed')
  })

  it('does not call an unreadable result complete', () => {
    /* Unreadable is not evidence of failure — calling it one sends the user to pay for a second
       generation of a trip they already have. It is not evidence of SUCCESS either, and that is
       the half the first fix got wrong: `complete` makes get_trip_progress say "the trip is
       ready" and the shell navigate to a trip that may not exist. `unknown` is the only honest
       verdict on a frame we could not read, and it sends the agent to the page rather than
       asserting either outcome. */
    const h = harness()
    h.start()
    h.emit({ type: 'result', content: 'not json at all' })
    expect(h.store.snapshot()!.status).toBe('unknown')
  })

  it('treats a result carrying a null error as FAILED — presence, not truthiness', () => {
    // `{"error": null}` reads as a failure frame that lost its message, never as a success.
    const h = harness()
    h.start()
    h.emit({ type: 'result', content: JSON.stringify({ error: null }) })
    expect(h.store.snapshot()!.status).toBe('failed')
  })

  it('marks the run unknown when it is stopped, rather than leaving it generating for ever', () => {
    /* stop() cancels the stream and hands the lock back, but used to leave the snapshot on
       'generating'. Nothing was watching that run any more, so get_trip_progress answered
       "generating" for ever and the page kept the wait screen up with no stream behind it.
       'unknown' is the honest verdict: the durable job may well still land. */
    const h = harness()
    h.start()
    h.store.stop()
    expect(h.store.snapshot()!.status).toBe('unknown')
  })

  it('leaves a finished run\'s verdict alone when the store is stopped', () => {
    // Downgrading a completed trip to 'unknown' on the way out would tell the agent it had lost
    // contact with a trip the page had already opened.
    const h = harness()
    h.start()
    h.emit({ type: 'result', content: JSON.stringify({ itinerary: {} }) })
    h.store.stop()
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

describe('readResultVerdict — success, failed, or unreadable', () => {
  /* Three outcomes, not two. A boolean `isFailure` collapsed "we could not read this" into
     "not a failure", which every caller then rendered as a finished trip. */

  it('reads the real success payload as success', () => {
    // What the backend actually writes on the happy path (pipeline/runner.py:652).
    expect(readResultVerdict(JSON.stringify({ itinerary: { days: [] } }))).toBe('success')
  })

  it('reads the real failure payload as failed', () => {
    expect(readResultVerdict(JSON.stringify({ error: 'lease lost' }))).toBe('failed')
  })

  it.each([
    ['a null error', JSON.stringify({ error: null })],
    ['an empty error', JSON.stringify({ error: '' })],
    ['a false error', JSON.stringify({ error: false })],
  ])('treats %s as failed — the field being THERE is the signal', (_label, content) => {
    /* The first fix tested `Boolean(parsed.error)`, so a failure frame whose message was empty,
       null or false read as a completed trip. The presence of the key is what the backend means
       by failure; its contents are only the reason. */
    expect(readResultVerdict(content)).toBe('failed')
  })

  it.each([
    ['not json at all'],
    [''],
    ['{"unterminated": '],
  ])('calls malformed JSON unreadable (%s)', (content) => {
    expect(readResultVerdict(content)).toBe('unreadable')
  })

  it.each([
    ['null', 'null'],
    ['a bare string', '"done"'],
    ['a number', '42'],
    ['an array', '[{"error":"x"}]'],
  ])('calls non-object JSON unreadable (%s)', (_label, content) => {
    // `JSON.parse` succeeds on all of these and `.error` is undefined, so a truthiness test
    // called every one of them a success.
    expect(readResultVerdict(content)).toBe('unreadable')
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

  it('never tells the agent a dead run is ready', async () => {
    // The whole point of the store fix: get_trip_progress is the agent's only view of the run.
    const h = harness()
    h.start()
    h.emit(stage('narrate', 'Writing your days'))
    h.emit({ type: 'result', content: JSON.stringify({ error: 'lease lost' }) })
    const out = String(await getTripProgressTool(h.store, 0).execute({}))
    expect(out).toContain('failed')
    expect(out).not.toContain('the trip is ready')
    expect(out).not.toContain('get_itinerary')
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

describe('get_trip_progress — the trip_id it was handed', () => {
  /* The schema advertised `trip_id` while `execute` took no argument at all, so the parameter
     was unreadable by construction — and its description, "Omit to use the run started in this
     browser", implied that PASSING it did something else. The store is browser-local and holds
     ONE run, so an agent with two trips in play could ask about A and be told, in confident
     prose, about B, then narrate that to the user as fact. Nothing errored. A silent-wrong
     answer in the one tool whose whole job is narrating truthfully. */

  const A = 'trip-aaaaaaaa-1111'
  const B = 'trip-bbbbbbbb-2222'

  it('never reports the running trip under an id the agent did not ask about', async () => {
    const h = harness()
    h.start(A)
    h.emit(stage('scrape', 'reel 1'))
    h.tick(40)
    const out = String(await getTripProgressTool(h.store, 0).execute({ trip_id: B }))
    expect(out).not.toContain('generating')
    expect(out).not.toContain('Scraping Reels')
    expect(out).not.toContain('40s')
    expect(out).toMatch(/not the run/i)
  })

  it('names the run it IS following, so the agent can correct itself', async () => {
    // A bare refusal leaves the agent guessing which of its two trips this page holds.
    const h = harness()
    h.start(A)
    const out = String(await getTripProgressTool(h.store, 0).execute({ trip_id: B }))
    expect(out).toContain(A.slice(0, 8))
  })

  it('never hands another trip\'s FINISHED verdict to the agent that asked', async () => {
    /* The sharpest form of it. A finished run skips the throttle entirely, and the complete
       branch answers "the trip is ready" and hands back `get_itinerary (trip_id …)` — with A's
       id, to an agent that asked about B. It would then fetch A and read it out as B's
       itinerary. `failed` is the same shape of lie in the other direction: the user is told a
       trip died that did not. */
    const h = harness()
    h.start(A)
    h.emit({ type: 'result', content: JSON.stringify({ itinerary: {} }) })
    const out = String(await getTripProgressTool(h.store, 0).execute({ trip_id: B }))
    expect(out).not.toContain('the trip is ready')
    expect(out).not.toContain('get_itinerary (trip_id')
    expect(out).toMatch(/not the run/i)
  })

  it('never hands another trip\'s FAILURE to the agent that asked', async () => {
    const h = harness()
    h.start(A)
    h.emit({ type: 'error', stage: 'scrape' as never, msg: 'apify timeout' })
    const out = String(await getTripProgressTool(h.store, 0).execute({ trip_id: B }))
    expect(out).not.toContain('failed')
    expect(out).not.toContain('apify timeout')
    expect(out).toMatch(/not the run/i)
  })

  it('answers normally when the id matches the run it is following', async () => {
    const h = harness()
    h.start(A)
    h.emit(stage('scrape', 'reel 1'))
    const out = String(await getTripProgressTool(h.store, 0).execute({ trip_id: A }))
    expect(out).toContain('generating')
    expect(out).toContain('Scraping Reels')
  })

  it('accepts the 8-char prefix this tool itself hands back', async () => {
    /* The complete branch answers `next_tool: get_itinerary (trip_id trip-aaa)` — an 8-char
       slice — so the id an agent echoes back is as often the prefix as the whole thing.
       Refusing the form this tool prints would be a self-inflicted mismatch. */
    const h = harness()
    h.start(A)
    h.emit(stage('scrape', 'reel 1'))
    const out = String(await getTripProgressTool(h.store, 0).execute({ trip_id: A.slice(0, 8) }))
    expect(out).toContain('generating')
  })

  it('refuses a prefix too short to identify anything', async () => {
    // A loose match IS the bug. Below the prefix this tool prints, refuse rather than guess.
    const h = harness()
    h.start(A)
    const out = String(await getTripProgressTool(h.store, 0).execute({ trip_id: 'trip' }))
    expect(out).toMatch(/not the run/i)
  })

  it('still answers about the browser\'s own run when no trip_id is given', async () => {
    const h = harness()
    h.start(A)
    h.emit(stage('scrape', 'reel 1'))
    const out = String(await getTripProgressTool(h.store, 0).execute({}))
    expect(out).toContain('generating')
  })

  it('does not answer under the old id when a NEW run starts mid-wait', async () => {
    /* The self-throttle re-reads the store after waiting, and start() replaces the snapshot
       wholesale. Checking the id only on the way in lets a run that began during those seconds
       be reported as progress for the trip the agent asked about — the same silent-wrong,
       arriving through the back door. */
    const h = harness()
    h.start(A)
    const pending = getTripProgressTool(h.store, 15_000).execute({ trip_id: A })
    h.start(B)
    h.emit(stage('scrape', 'reel 1'))
    const out = String(await pending)
    expect(out).toMatch(/not the run/i)
    expect(out).not.toContain('Scraping Reels')
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

  it('does not tell the agent the reels have to be SAVED first', () => {
    /* The same false prerequisite already removed from get_app_state's snapshot, still standing
       in the sentence the agent reads right beside it: "from 1-5 saved Instagram Reels" sends it
       to the save form on an empty account instead of asking for links it could plan from. The
       tool normalizes raw pasted URLs and the backend runs no ownership check on `reel_urls`, so
       saving is one SOURCE of links and never a precondition. */
    const description = planTripFromReelsTool(deps()).description
    expect(description).not.toMatch(/saved Instagram Reels/i)
    expect(description).toContain('saving them first is optional')
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

describe('plan_trip_from_reels — what the approval card says about cost', () => {
  const url = (code: string) => `https://www.instagram.com/reel/${code}/`
  /** A library reader returning entries in the shape list_saved_reels already produces. */
  const lib = (entries: { url: string; hasCurrentCache: boolean }[]) =>
    vi.fn().mockResolvedValue(
      entries.map((e) => ({ ...e, caption: null, status: 'organized', places: [] })),
    )

  const deps = (over = {}) => ({
    store: createGenerationStore(),
    create: vi.fn().mockResolvedValue('trip-123'),
    openStream: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    ...over,
  })

  const run = (d: ReturnType<typeof deps>, urls: string[]) =>
    planTripFromReelsTool(d).execute({
      reel_urls: urls, start_date: '2026-03-03', end_date: '2026-03-07',
    })

  it('says how many of the reels Astrail has already read', async () => {
    const d = deps({ readLibrary: lib([
      { url: url('AAA'), hasCurrentCache: true },
      { url: url('BBB'), hasCurrentCache: true },
      { url: url('CCC'), hasCurrentCache: false },
    ]) })
    await run(d, [url('AAA'), url('BBB'), url('CCC')])
    expect(d.confirm.mock.calls[0][0]).toContain('2 of 3')
  })

  it('says so plainly when every reel is already read', async () => {
    const d = deps({ readLibrary: lib([
      { url: url('AAA'), hasCurrentCache: true },
      { url: url('BBB'), hasCurrentCache: true },
    ]) })
    await run(d, [url('AAA'), url('BBB')])
    const card = d.confirm.mock.calls[0][0]
    expect(card).toMatch(/all 2 .*already been read/i)
  })

  it('says none are read when the library has none of them', async () => {
    const d = deps({ readLibrary: lib([{ url: url('ZZZ'), hasCurrentCache: true }]) })
    await run(d, [url('AAA'), url('BBB')])
    expect(d.confirm.mock.calls[0][0]).toMatch(/none of these 2/i)
  })

  it('matches on the normalized URL, not the string the agent happened to send', async () => {
    // The library stores normalized_url; an agent may pass a share link with a query string.
    // Two reels deliberately: this is about URL matching, not about how the card words "1".
    const d = deps({ readLibrary: lib([
      { url: url('AAA'), hasCurrentCache: true },
      { url: url('BBB'), hasCurrentCache: true },
    ]) })
    await run(d, ['https://instagram.com/reel/AAA/?igshid=xyz', 'instagram.com/reel/BBB'])
    expect(d.confirm.mock.calls[0][0]).toMatch(/all 2 .*already been read/i)
  })

  it('words a single reel as a sentence, not as "All 1 reel"', async () => {
    const d = deps({ readLibrary: lib([{ url: url('AAA'), hasCurrentCache: true }]) })
    await run(d, [url('AAA')])
    const card = d.confirm.mock.calls[0][0]
    expect(card).toMatch(/already read this reel/i)
    expect(card).not.toMatch(/all 1/i)
  })

  it('says NOTHING about cost when the library cannot be read', async () => {
    // A confident "none are read" from a failed read would tell the user this costs more than it
    // does. Omitting the line is the only honest option — the same rule list_saved_reels follows.
    const d = deps({ readLibrary: vi.fn().mockRejectedValue(new Error('offline')) })
    await run(d, [url('AAA'), url('BBB')])
    const card = d.confirm.mock.calls[0][0]
    expect(card).not.toMatch(/already read|none of these/i)
    expect(d.create).toHaveBeenCalled()   // and it must not block the run
  })

  it('says nothing about cost when no library reader is wired at all', async () => {
    const d = deps()
    await run(d, [url('AAA')])
    expect(d.confirm.mock.calls[0][0]).not.toMatch(/already read|none of these/i)
  })

  it('still shows the dates and the allowance warning alongside the cost line', async () => {
    const d = deps({ readLibrary: lib([{ url: url('AAA'), hasCurrentCache: true }]) })
    await run(d, [url('AAA')])
    const card = d.confirm.mock.calls[0][0]
    expect(card).toContain('2026-03-03')
    expect(card).toContain('allowance')
  })
})

describe('plan_trip_from_reels — an allowance it cannot spend', () => {
  const url = 'https://www.instagram.com/reel/Cabc123/'

  const deps = (over = {}) => ({
    store: createGenerationStore(),
    create: vi.fn().mockResolvedValue('trip-123'),
    openStream: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    ...over,
  })

  const run = (d: ReturnType<typeof deps>) =>
    planTripFromReelsTool(d).execute({
      reel_urls: [url], start_date: '2026-03-03', end_date: '2026-03-07',
    })

  it('never shows the approval card when the free trial is already spent', async () => {
    /* The captured defect: the tool had no entitlement dependency at all, so an exhausted
       account got the approval card, the user approved the spend, and only THEN did the backend
       refuse. Approve-then-rejected is the worst order to fail in — consent is taken first and
       nothing comes back that explains why. A trial account has ONE lifetime generation. */
    const d = deps({ readAllowance: vi.fn().mockResolvedValue('trial_exhausted') })
    const out = String(await run(d))
    expect(d.confirm).not.toHaveBeenCalled()
    expect(d.create).not.toHaveBeenCalled()
    expect(d.openStream).not.toHaveBeenCalled()
    expect(out).toMatch(/free trial/i)
  })

  it('names the LIFETIME trial, and that this one does not come back', async () => {
    // "Rejected" on its own leaves the agent guessing between a limit that resets overnight and
    // one that never does. Only one of those is worth telling the user to wait for.
    const d = deps({ readAllowance: vi.fn().mockResolvedValue('trial_exhausted') })
    const out = String(await run(d))
    expect(out).toMatch(/does not reset/i)
    expect(out).toMatch(/seat/i)
    expect(out).toMatch(/nothing was spent/i)
  })

  it('does not send the user hunting for a card that is not on their screen', async () => {
    /* The captured defect: this said `point them at the "Request a seat" card on this page`.
       TrialExhaustedCard renders in exactly two places — SavedReelsFlow's plan sheet, and
       CreateTripFlow, which only exists under the mock-auth demo shell. The agent-first trays
       screen (TraysScreen) renders neither, and that is the flow these tools were built for. So
       the agent confidently pointed at a card that was not on the screen: the user hunts for it,
       finds nothing, and the agent looks broken at the exact moment it is delivering bad news.
       Naming the button AND that it is not always on screen is true in either flow. */
    const d = deps({ readAllowance: vi.fn().mockResolvedValue('trial_exhausted') })
    const out = String(await run(d))
    expect(out).not.toMatch(/on this page/i)
    expect(out).toMatch(/not on every screen/i)
    expect(out).toMatch(/no tool can request a seat/i)
    expect(out).toMatch(/plan screen/i)
  })

  it('does not even read the reel library for a spend that cannot happen', async () => {
    const readLibrary = vi.fn().mockResolvedValue([])
    const d = deps({ readAllowance: vi.fn().mockResolvedValue('trial_exhausted'), readLibrary })
    await run(d)
    expect(readLibrary).not.toHaveBeenCalled()
  })

  it('consults the allowance and PROCEEDS anyway when it is not known', async () => {
    /* Never a confident zero on data we failed to read. An advisory read that has not landed is
       evidence of nothing, and a false refusal costs the user a trip they were entitled to —
       strictly worse than the backend refusing a beat later. The backend RPC stays the authority. */
    const readAllowance = vi.fn().mockResolvedValue('unknown')
    const d = deps({ readAllowance })
    await run(d)
    expect(readAllowance).toHaveBeenCalled()
    expect(d.confirm).toHaveBeenCalled()
    expect(d.create).toHaveBeenCalled()
  })

  it('proceeds when the allowance read itself throws', async () => {
    const readAllowance = vi.fn().mockRejectedValue(new Error('offline'))
    const d = deps({ readAllowance })
    await run(d)
    expect(readAllowance).toHaveBeenCalled()
    expect(d.confirm).toHaveBeenCalled()
    expect(d.create).toHaveBeenCalled()
  })

  it('proceeds when no allowance reader is wired at all', async () => {
    const d = deps()
    await run(d)
    expect(d.confirm).toHaveBeenCalled()
  })
})

describe('plan_trip_from_reels — refused by the backend after the user approved', () => {
  const url = 'https://www.instagram.com/reel/Cabc123/'

  const deps = (over = {}) => ({
    store: createGenerationStore(),
    create: vi.fn().mockResolvedValue('trip-123'),
    openStream: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    ...over,
  })

  const run = (d: ReturnType<typeof deps>) =>
    planTripFromReelsTool(d).execute({
      reel_urls: [url], start_date: '2026-03-03', end_date: '2026-03-07',
    })

  it('explains a trial rejection rather than handing back a raw backend error', async () => {
    /* The pre-gate is a courtesy, not a boundary: a stale client state or a manual generation
       started in another tab still lands here. What came back was an isError text response
       carrying the backend's marketing sentence, which never says the run did not start. */
    const d = deps({
      create: vi.fn().mockRejectedValue(new ApiError(
        403, ERROR_CODE_TRIAL_EXHAUSTED,
        'Your free trip is planned. Beta seats unlock unlimited planning — only 25 exist.',
      )),
    })
    const out = String(await run(d))
    expect(out).toMatch(/free trial/i)
    expect(out).toMatch(/does not reset/i)
    expect(out).toMatch(/no trip was created/i)
    expect(d.openStream).not.toHaveBeenCalled()
  })

  it('tells the agent where a seat is actually requested, so it invents no path', async () => {
    /* This message named no card — but it named no route to a seat either, having said a seat
       is the only thing that lifts the limit. An agent asked to relay that and given nowhere to
       send the user improvises, and the nearest improvisation is the card the sibling message
       used to hallucinate. Both refusals now carry the same, checkable answer. */
    const d = deps({
      create: vi.fn().mockRejectedValue(new ApiError(
        403, ERROR_CODE_TRIAL_EXHAUSTED, 'Your free trip is planned.',
      )),
    })
    const out = String(await run(d))
    expect(out).toMatch(/no tool can request a seat/i)
    expect(out).toMatch(/not on every screen/i)
    expect(out).toMatch(/plan screen/i)
    expect(out).not.toMatch(/on this page/i)
  })

  it("relays the backend's own sentence for a rate limit, inventing no reset time", async () => {
    /* 429 `rate_limited` covers BOTH the beta daily quota and the 3/minute burst limiter (they
       share a slug — backend api/errors.py maps every 429 to it), and those lift on completely
       different clocks. Quoting the backend is the only way to name the right one. */
    const d = deps({
      create: vi.fn().mockRejectedValue(new ApiError(
        429, ERROR_CODE_RATE_LIMITED, 'Daily trip limit reached. Try again tomorrow.',
      )),
    })
    const out = String(await run(d))
    expect(out).toContain('Daily trip limit reached. Try again tomorrow.')
    expect(out).toMatch(/no trip was created/i)
    expect(out).not.toMatch(/free trial/i)
  })

  it('still throws on a failure it cannot explain', async () => {
    // The obvious wrong fix is a broad catch that turns every backend failure into a calm
    // sentence. A 503 is not a refusal and must stay an error the activity rail marks failed.
    const d = deps({
      create: vi.fn().mockRejectedValue(new ApiError(503, 'identity_unavailable', 'nope')),
    })
    await expect(run(d)).rejects.toThrow('nope')
  })

  it('still throws when the in-page run lock is already held', async () => {
    const d = deps({ create: vi.fn().mockRejectedValue(new Error('A trip is already being built.')) })
    await expect(run(d)).rejects.toThrow('already being built')
  })
})
