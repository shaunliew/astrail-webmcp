import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StreamEvent } from '@/lib/trip/backend-types'
import { ERROR_CODE_RATE_LIMITED, ERROR_CODE_TRIAL_EXHAUSTED } from '@/lib/trip/backend-types'
import { ApiError } from '@/lib/trip/api'
import { createGenerationStore, readResultVerdict } from '../generation'
import { getTripProgressTool, planTripFromReelsTool } from '../tools/generation'
import { readToolOutcome } from '../tools/edit'
import { fitsBudget } from '../fit'

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

  /* THE ASK GATE.

     A trip planned with no stated preferences AND nothing remembered falls back to inferred
     defaults — a generic first draft that also teaches Astrail nothing, because the write only
     fires on an explicit preference (pipeline/preferences.py:100-101). So the tool asks first
     rather than spending the user's allowance on it.

     What these pin is the ASYMMETRY: only a DEFINITE empty asks. Unknown proceeds, because
     interrogating a user who has preferences saved — on a memory read that merely failed — is
     the worse of the two failures, and it is the one guardrail #3 exists to prevent. */
  const emptyMemory = () => vi.fn().mockResolvedValue({ status: 'ok', facts: [] })
  const savedMemory = () => vi.fn().mockResolvedValue({
    status: 'ok',
    facts: [{ id: 'm1', memory: 'Prefers walkable days', created_at: '2026-08-01T00:00:00Z', source: 'mem0' }],
  })
  const plan = (d: ReturnType<typeof deps>, over = {}) => planTripFromReelsTool(d).execute({
    reel_urls: ['https://www.instagram.com/reel/Cabc123/'],
    start_date: '2026-03-03', end_date: '2026-03-07', ...over,
  })

  it('asks how the user travels when nothing is stated and nothing is remembered', async () => {
    const d = deps({ readMemory: emptyMemory() })
    const out = String(await plan(d))
    expect(out).toMatch(/ask them/i)
    expect(d.confirm, 'showed a card for a run it was not going to start').not.toHaveBeenCalled()
    expect(d.create, 'spent the allowance before asking').not.toHaveBeenCalled()
  })

  it('lets a user who declines get their trip, instead of asking forever', async () => {
    /* THE LOOP THIS TEST EXISTS FOR. The first version of the escape hatch told the agent to
       "call this again with `preferences` omitted" — but omitting `preferences` is the SAME
       state that triggers the ask, so a user who declined got asked again, and again. A
       cross-model verification pass caught it; nothing here would have.

       `no_preferences` is a separate signal, and it deliberately does not become a preference:
       storing "no particular preferences" would teach the account a fact it then recalls on
       every future blank-preferences trip. */
    const d = deps({ readMemory: emptyMemory() })
    await plan(d, { no_preferences: true })
    expect(d.create, 'declining to state preferences could not get a trip planned').toHaveBeenCalled()
    expect(d.confirm).toHaveBeenCalled()
  })

  it('does not turn a decline into a remembered preference', async () => {
    const d = deps({ readMemory: emptyMemory() })
    await plan(d, { no_preferences: true })
    // null, not a placeholder string: the backend writes any non-blank value to mem0 verbatim.
    expect(d.create.mock.calls[0][0].preferences).toBeNull()
  })

  it('remembers nothing when a decline arrives alongside a preference string', async () => {
    /* Both fields together is schema-valid, and honouring the string while skipping the ask
       would write a memory the parameter's own description promises it will not. Declining is a
       statement about the user, so it wins — found by a cross-model pass, not by this suite. */
    const d = deps({ readMemory: emptyMemory() })
    await plan(d, { preferences: 'quiet days', no_preferences: true })
    expect(d.create.mock.calls[0][0].preferences, 'a decline still sent a preference to be stored').toBeNull()
  })

  it('declares no_preferences in its schema, not just in its branch', () => {
    /* The tests above call execute() directly, which bypasses `additionalProperties: false`.
       Deleting the property from the schema would leave them green while making the field
       unsendable — the ask would name an input the agent is not allowed to pass. */
    const schema = planTripFromReelsTool(deps()).inputSchema
    expect(schema?.properties).toHaveProperty('no_preferences')
    expect((schema?.properties as Record<string, { type?: string }>).no_preferences.type).toBe('boolean')
  })

  it('does NOT ask when the user stated preferences this trip', async () => {
    // The reader is held locally: `deps()` spreads overrides, so the returned type does not
    // widen to include them, and asserting through it would need a cast that hides the intent.
    const readMemory = emptyMemory()
    const d = deps({ readMemory })
    await plan(d, { preferences: 'walkable days, ramen' })
    expect(d.create).toHaveBeenCalled()
    expect(readMemory, 'read memory it had no reason to read').not.toHaveBeenCalled()
  })

  it('does NOT ask a user who already has saved preferences', async () => {
    const d = deps({ readMemory: savedMemory() })
    await plan(d)
    expect(d.create).toHaveBeenCalled()
  })

  it('plans anyway when the memory read fails — unknown is not empty', async () => {
    const d = deps({ readMemory: vi.fn().mockRejectedValue(new Error('mem0 down')) })
    await plan(d)
    expect(d.create, 'a failed memory read blocked a trip').toHaveBeenCalled()
  })

  it('plans anyway when memory is switched off entirely', async () => {
    // `disabled` is a configuration state, not evidence about this user.
    const d = deps({ readMemory: vi.fn().mockResolvedValue({ status: 'disabled', facts: [] }) })
    await plan(d)
    expect(d.create).toHaveBeenCalled()
  })

  it('plans anyway when there is no memory reader at all', async () => {
    /* This assertion used to be `expect(deps().create).toBeDefined()` — a check on a FRESH,
       unrelated deps object, which would have passed even if the real call returned early and
       never planned. A cross-model review caught it. It asserts the object actually used now. */
    const d = deps()
    await plan(d)
    expect(d.create, 'a missing memory reader read as "this user has nothing"').toHaveBeenCalled()
  })

  it('never promises the card an outcome the recall can still veto', async () => {
    /* The card reads the STORED set (get_all). The generation runs an independent semantic
       search that can miss, time out, or error and then falls back to inferred defaults in
       silence (backend/pipeline/preferences.py:105-125). So the card may say Astrail will TRY,
       never that it WILL — this is the sentence a user reads while deciding to spend. */
    const d = deps({ readMemory: savedMemory() })
    await plan(d)
    const card = String(d.confirm.mock.calls[0][0])
    expect(card).toMatch(/try to recall/i)
    expect(card, 'the card promised an outcome a later search decides').not.toMatch(/will use what it remembers/i)
  })

  it('does not promise the ask will be remembered, only that it can be', async () => {
    // Write-back is best-effort and swallows five separate failure modes by design.
    const out = String(await plan(deps({ readMemory: emptyMemory() })))
    expect(out).toMatch(/can remember/i)
    expect(out, 'promised a write-back that is explicitly best-effort').not.toMatch(/Astrail remembers it for/i)
  })

  /* A QUESTION IS NOT A FAILURE.

     The ask-gate left through `notStarted(..., 'failed')`, so the activity rail — the surface
     whose whole job is saying truthfully what the agent did — printed a red `PLANNING FAILED`
     for Astrail politely asking how the user likes to travel. Nothing broke, nothing was spent,
     and the run is one answer away. `asked` is the fourth ending: nothing happened, and the
     reason is a question rather than a fault. The failures around it must stay failures, which
     is the half of this that a single-case test would not catch. */
  const outcomeOf = (out: unknown) => (JSON.parse(String(out)) as { outcome: string }).outcome

  it('records the preferences question as a question, not as a failure', async () => {
    const out = await plan(deps({ readMemory: emptyMemory() }))
    expect(outcomeOf(out), 'a question the user can answer was recorded as a failure').toBe('asked')
  })

  it('survives the round trip the rail actually makes', async () => {
    /* THE TEST THAT CATCHES A NEAR-MISS, which parsing the JSON here does not.
       `notStarted` stringifies whatever word it is handed; `readToolOutcome` then checks that
       word against `EDIT_VERDICTS` and — by design, so a tool answering in prose is not read as
       a failure — collapses ANYTHING it does not recognise to `done`. So `'asking'` at the call
       site would report the run as SUCCEEDED on the rail, with "Astrail can't undo this" under
       it, for a run that never started. That is the original defect, restored by a typo.

       The parameter is typed off `EditVerdict` now, so a near-miss is also a compile error. This
       is the second lock, not the first: the value crosses a JSON string, and a string is where
       type safety ends. */
    const out = await plan(deps({ readMemory: emptyMemory() }))
    const { outcome } = readToolOutcome(out)
    expect(outcome).toBe('asked')
    expect(outcome, 'an unrecognised word silently became a success').not.toBe('done')
  })

  it('credits the question to nobody — the tool is waiting, not reporting a decision', async () => {
    // A decision nobody made must not be attributed to the user who was shown no card.
    const out = JSON.parse(String(await plan(deps({ readMemory: emptyMemory() })))) as { decided_by: string }
    expect(out.decided_by).toBe('nobody')
  })

  it('still calls a real failure a failure', async () => {
    /* The five bail-outs that are genuinely wrong — a link that is not a Reel, more reels than
       the pipeline takes, two shapes of bad date, and an allowance that is already spent. None
       of these is a question, and softening them would hide a broken call behind the new word. */
    const d = () => deps({ readMemory: savedMemory() })
    expect(outcomeOf(await plan(d(), { reel_urls: ['not-a-reel'] })), 'invalid urls').toBe('failed')
    expect(outcomeOf(await plan(d(), { reel_urls: Array.from({ length: 6 }, (_, i) => `https://www.instagram.com/reel/C${i}abc/`) })), 'too many reels').toBe('failed')
    expect(outcomeOf(await plan(d(), { start_date: '3 March' })), 'unparseable date').toBe('failed')
    expect(outcomeOf(await plan(d(), { start_date: '2026-03-09', end_date: '2026-03-03' })), 'reversed range').toBe('failed')
    expect(outcomeOf(await plan(deps({ readMemory: savedMemory(), readAllowance: vi.fn().mockResolvedValue('trial_exhausted') }))), 'trial spent').toBe('failed')
  })

  it('tells the user on the card when saved preferences will be used', async () => {
    const d = deps({ readMemory: savedMemory() })
    await plan(d)
    expect(String(d.confirm.mock.calls[0][0])).toMatch(/what it remembers about how you travel/i)
  })

  it('names the preferences it will try to recall, not just that it will try', async () => {
    /* On trip 2+ the card said only "Astrail will try to recall what it remembers about how you
       travel" — so approving meant consenting to preferences the user could not see. The facts
       were already fetched at this point and thrown away; the card names them now, and approving
       is an informed choice rather than a leap. */
    const d = deps({ readMemory: savedMemory() })
    await plan(d)
    expect(String(d.confirm.mock.calls[0][0])).toContain('Prefers walkable days')
  })

  it('caps what the card names, however much an account has remembered', async () => {
    /* mem0 puts no ceiling on what one account accumulates, and the card is the surface where
       the user reads what approving costs them. An unbounded list pushes "This uses your trip
       allowance" — the actual decision — off the bottom of it. */
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`, memory: `Remembered preference number ${i}`, created_at: '2026-08-01T00:00:00Z', source: 'mem0' as const,
    }))
    const d = deps({ readMemory: vi.fn().mockResolvedValue({ status: 'ok', facts: many }) })
    await plan(d)
    const line = String(d.confirm.mock.calls[0][0]).split('\n').find((l) => /try to recall/.test(l))!
    expect(line.length, 'the card grew with the account').toBeLessThan(280)
    expect(line).not.toContain('number 19')
  })

  it('still only tries, even now that it can name what it holds', async () => {
    /* Naming the facts makes the promise sound firmer, which is exactly when this matters. What
       was read is the STORED set (get_all); the generation runs an independent semantic search
       (backend/pipeline/preferences.py:105-125) that can still miss every one of them. */
    const d = deps({ readMemory: savedMemory() })
    await plan(d)
    const card = String(d.confirm.mock.calls[0][0])
    expect(card).toMatch(/try to recall/i)
    expect(card, 'naming the facts turned a best effort into a promise').not.toMatch(/will use/i)
  })

  it('names nothing when the memories came back unreadable', async () => {
    // `facts.length > 0` is not evidence there is anything to SAY. A blank memory would have
    // produced a card ending in a colon and nothing after it.
    const d = deps({ readMemory: vi.fn().mockResolvedValue({ status: 'ok', facts: [{ id: 'm1', memory: '   ', created_at: '2026-08-01T00:00:00Z', source: 'mem0' }] }) })
    await plan(d)
    const card = String(d.confirm.mock.calls[0][0])
    expect(card).toMatch(/try to recall/i)
    // The plain sentence, ending in a full stop — not the naming form with nothing after it.
    expect(card, 'the card promised a list and then gave none').not.toMatch(/how you travel:/)
    expect(card).toContain('how you travel.')
  })

  it('promises nothing about memory on the card when the read failed', async () => {
    // The card is where the user decides to spend. A line claiming remembered preferences we
    // could not read would be a claim, not a note.
    const d = deps({ readMemory: vi.fn().mockResolvedValue({ status: 'unavailable', facts: [] }) })
    await plan(d)
    expect(String(d.confirm.mock.calls[0][0])).not.toMatch(/what it remembers/i)
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

  it('does not report a decline for a card that was never shown', async () => {
    /* `requestConfirm` allows one approval at a time and turns a second request away on the spot.
       It used to do that by resolving `false` — the same value a real "Not now" produces — so this
       tool answered "The user declined" about someone who had been shown nothing, and the agent
       repeats that to them as fact. This tool spends the one lifetime free trip, so the two cases
       lead somewhere different: a decline is final, an unshown card is worth asking again. */
    const d = deps({ confirm: vi.fn().mockResolvedValue('unavailable') })
    const out = String(await planTripFromReelsTool(d).execute({
      reel_urls: ['https://www.instagram.com/reel/Cabc123/'],
      start_date: '2026-03-03', end_date: '2026-03-07',
    }))
    expect(d.create).not.toHaveBeenCalled()
    expect(out).not.toMatch(/declined/i)
    expect(out).toContain('another approval is already waiting')
    expect(out).toContain('Ask again')
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

  it('does not resolve until the wait screen is on screen', async () => {
    /* `openStream` is what puts the run in front of the user — the shell attaches it and the
       app moves to the page that renders it. Returning while that is still in flight is how the
       agent ends up announcing a trip is building beside a settings page that never changed. */
    let arrive!: () => void
    const arrived = new Promise<void>((resolve) => { arrive = resolve })
    const openStream = vi.fn(() => arrived)
    const call = Promise.resolve(planTripFromReelsTool(deps({ openStream })).execute({
      reel_urls: ['https://www.instagram.com/reel/Cabc123/'],
      start_date: '2026-03-03', end_date: '2026-03-07',
    }))
    let done = false
    void call.then(() => { done = true })
    await vi.waitFor(() => { expect(openStream).toHaveBeenCalled() })
    expect(done).toBe(false)
    arrive()
    await call
    expect(done).toBe(true)
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

describe('plan_trip_from_reels — putting the reels in the user\'s library', () => {
  const url = (code: string) => `https://www.instagram.com/reel/${code}/`

  const deps = (over = {}) => ({
    store: createGenerationStore(),
    create: vi.fn().mockResolvedValue('trip-123'),
    openStream: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    saveToLibrary: vi.fn().mockResolvedValue({ id: 'sr-1' }),
    ...over,
  })

  const run = (d: ReturnType<typeof deps>, urls: string[] = [url('AAA')]) =>
    planTripFromReelsTool(d).execute({
      reel_urls: urls, start_date: '2026-03-03', end_date: '2026-03-07',
    })

  it('puts every reel it plans from into the library', async () => {
    /* The reported defect: planning from raw links read the library (to price the card) and
       never wrote to it, so a trip built from three reels left the user with an empty
       collection and no thumbnails — the reels were in the pipeline's `reel_cache`, which the
       library only reaches through a `saved_reels` row that nothing created. */
    const d = deps()
    await run(d, [url('AAA'), url('BBB')])
    expect(d.saveToLibrary.mock.calls.map((c) => c[0])).toEqual([url('AAA'), url('BBB')])
  })

  it('saves the NORMALIZED url, so the library row joins the cache the run will fill', async () => {
    // `reel_cache` and `saved_reels` are both keyed on normalized_url; a share link saved raw
    // would sit beside its own cache row instead of linking to it.
    const d = deps()
    await run(d, ['https://instagram.com/reel/AAA/?igshid=xyz'])
    expect(d.saveToLibrary).toHaveBeenCalledWith(url('AAA'))
  })

  it('saves a repeated link once, not once per mention', async () => {
    const d = deps()
    await run(d, [url('AAA'), 'instagram.com/reel/AAA'])
    expect(d.saveToLibrary).toHaveBeenCalledTimes(1)
  })

  it('writes NOTHING before the user approves', async () => {
    const d = deps({ confirm: vi.fn().mockResolvedValue(false) })
    await run(d)
    expect(d.saveToLibrary).not.toHaveBeenCalled()
  })

  it('writes nothing when the trial gate refuses before the card', async () => {
    const d = deps({ readAllowance: vi.fn().mockResolvedValue('trial_exhausted') })
    await run(d)
    expect(d.saveToLibrary).not.toHaveBeenCalled()
  })

  it('writes nothing when the backend refuses the run the user approved', async () => {
    // "No trip was created and nothing was spent" has to stay literally true, so the library
    // write lives after `create` succeeds — a refused run leaves the library untouched.
    const d = deps({
      create: vi.fn().mockRejectedValue(new ApiError(
        403, ERROR_CODE_TRIAL_EXHAUSTED, 'Your free trip is planned.',
      )),
    })
    await run(d)
    expect(d.saveToLibrary).not.toHaveBeenCalled()
  })

  it('does not cost the user their trip when the library write fails', async () => {
    /* Guardrail #3. The generation is already running by the time this is attempted; a rejected
       save must be reported, never raised. */
    const d = deps({ saveToLibrary: vi.fn().mockRejectedValue(new Error('offline')) })
    const out = String(await run(d, [url('AAA'), url('BBB')]))
    const parsed = JSON.parse(out)
    expect(parsed.trip_id).toBe('trip-123')
    expect(d.openStream).toHaveBeenCalledWith('trip-123')
    expect(parsed.saved_to_library).toBe(0)
    expect(String(parsed.library)).toMatch(/not.*(saved|added)/i)
  })

  it('reports a partial save as partial, not as success', async () => {
    const saveToLibrary = vi.fn()
      .mockResolvedValueOnce({ id: 'sr-1' })
      .mockRejectedValueOnce(new Error('rate limited'))
    const d = deps({ saveToLibrary })
    const parsed = JSON.parse(String(await run(d, [url('AAA'), url('BBB')])))
    expect(parsed.saved_to_library).toBe(1)
    expect(String(parsed.library)).toContain('1 of 2')
  })

  it('never starts extraction itself, and tells the agent not to either', async () => {
    /* The trap this design exists to avoid: the organize job and the generation pipeline BOTH
       scrape through Apify on a cache miss (backend/organizer.py `_process_item`,
       backend/pipeline/runner.py), and they share one write-through cache keyed on
       normalized_url + EXTRACTOR_VERSION. Extracting here would race the run this call just
       started and pay Apify twice for the same reel.

       The ordering is no longer the AGENT's to get right — GlobalTools organizes these reels on
       the run's successful terminal frame — so the note has to say two things: the places are
       coming, and do not go and fetch them. An agent that ignores the second races that job and
       collects a 409 from the RPC's per-reel fence. */
    const d = deps()
    const parsed = JSON.parse(String(await run(d)))
    const library = String(parsed.library)
    expect(library).toMatch(/automatically/i)
    expect(library).toMatch(/do not call save_reels/i)
    // The old copy INSTRUCTED the organize the caller now performs; an agent reading both would
    // do it twice.
    expect(library).not.toMatch(/organize the reels? after/i)
  })

  it('tells the user on the approval card that this writes to their library', async () => {
    // Approving "plan a trip" must not quietly also mean "and file these in my collection".
    const d = deps()
    await run(d, [url('AAA'), url('BBB')])
    expect(d.confirm.mock.calls[0][0]).toMatch(/librar/i)
  })

  it('does not promise the places are there yet — it says when they arrive', async () => {
    /* The card view only shows places once `analysis_status` is `organized`, which happens after
       this run finishes. It must not tell the user to go and organize them either: that is the
       caller's job now, and asking is asking for duplicated work. */
    const d = deps()
    await run(d)
    const card = String(d.confirm.mock.calls[0][0])
    expect(card).toMatch(/fill in once the trip is built/i)
    expect(card).not.toMatch(/when you organi[sz]e/i)
  })

  it('stays inside the tool-output budget with the library line attached', async () => {
    // The library sentence is the longest thing this tool has ever returned, and the
    // spec-contract budget sweep cannot see it: `saveToLibrary` is optional, so the specs that
    // sweep builds never carry one. Guarded here instead, at the full five reels.
    const d = deps()
    const out = String(await run(d, ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map(url)))
    expect(fitsBudget(out)).toBe(true)
  })

  it('says nothing about a library it cannot write to', async () => {
    const d = deps({ saveToLibrary: undefined })
    const parsed = JSON.parse(String(await run(d)))
    expect(d.confirm.mock.calls[0][0]).not.toMatch(/librar/i)
    expect(parsed).not.toHaveProperty('saved_to_library')
    expect(parsed.trip_id).toBe('trip-123')
  })
})

/* THE PREFERENCE CARD.

   Trip 2 worked and was still wrong: the user stated nothing, recall fired, and the trip was
   built from "walkable days, good ramen, not too rushed" without anyone being asked. The card
   NAMED them, which is where this started — but naming is not consent, and a remembered
   preference is a default, not a mandate. Preferences change per trip.

   So exactly one branch of the card grows a field: the one that says Astrail will try to recall.
   Everything else — stated preferences, `no_preferences`, an empty store, an unreadable one —
   keeps the plain confirm, and so does a caller that does not wire the new dep at all. */
describe('plan_trip_from_reels — a different answer for this trip', () => {
  const savedMemory = () => vi.fn().mockResolvedValue({
    status: 'ok',
    facts: [{ id: 'm1', memory: 'Prefers walkable days', created_at: '2026-08-01T00:00:00Z', source: 'mem0' }],
  })
  const deps = (over: Record<string, unknown> = {}) => ({
    store: createGenerationStore(),
    create: vi.fn().mockResolvedValue('trip-123'),
    openStream: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    readMemory: savedMemory(),
    confirmWithPreferences: vi.fn().mockResolvedValue({ approved: true, text: null }),
    ...over,
  })
  const plan = (d: ReturnType<typeof deps>, over: Record<string, unknown> = {}) =>
    planTripFromReelsTool(d).execute({
      reel_urls: ['https://www.instagram.com/reel/Cabc123/'],
      start_date: '2026-03-03', end_date: '2026-03-07', ...over,
    })
  const sentPreferences = (d: ReturnType<typeof deps>) =>
    (d.create.mock.calls[0][0] as { preferences: string | null }).preferences

  it('offers the field on the branch that says it will try to recall, and only there', async () => {
    const d = deps()
    await plan(d)
    expect(d.confirmWithPreferences).toHaveBeenCalled()
    expect(d.confirm, 'two cards for one decision').not.toHaveBeenCalled()
    expect(String(d.confirmWithPreferences.mock.calls[0][0])).toMatch(/try to recall/i)
  })

  it('keeps the plain card when the user stated preferences this trip', async () => {
    const d = deps()
    await plan(d, { preferences: 'quiet places, no crowds' })
    expect(d.confirm).toHaveBeenCalled()
    expect(d.confirmWithPreferences, 'asked again for an answer already given').not.toHaveBeenCalled()
  })

  it('keeps the plain card when the user was asked and declined to say', async () => {
    const d = deps()
    await plan(d, { no_preferences: true })
    expect(d.confirm).toHaveBeenCalled()
    expect(d.confirmWithPreferences).not.toHaveBeenCalled()
  })

  it('keeps the plain card when the memory read failed', async () => {
    // No remembered line on the card, so nothing to offer an alternative TO.
    const d = deps({ readMemory: vi.fn().mockResolvedValue({ status: 'unavailable', facts: [] }) })
    await plan(d)
    expect(d.confirm).toHaveBeenCalled()
    expect(d.confirmWithPreferences).not.toHaveBeenCalled()
  })

  it('falls back to the plain card for a caller that never wired the field', async () => {
    // The spec contract and every existing test build deps without it. Absent must mean today.
    const d = deps({ confirmWithPreferences: undefined })
    await plan(d)
    expect(d.confirm).toHaveBeenCalled()
    expect(sentPreferences(d)).toBeNull()
  })

  it('still only tries to recall — the field did not turn the hedge into a promise', async () => {
    const d = deps()
    await plan(d)
    const card = String(d.confirmWithPreferences.mock.calls[0][0])
    expect(card).toMatch(/try to recall/i)
    expect(card).toContain('Prefers walkable days')
    expect(card).not.toMatch(/will use/i)
  })

  it('behaves exactly as it does today when the field is left blank', async () => {
    const d = deps()
    await plan(d)
    expect(sentPreferences(d), 'a blank field became a stated preference').toBeNull()
  })

  it('sends what the user typed as THIS trip\'s preferences, which is what a write-back needs', async () => {
    /* The whole point. `preferences` is what `pipeline/preferences.py` classifies explicit —
       it skips recall for this run and gives the write-back something to store — which is best-effort
       and can still fail, so this proves the SEND, never the persistence. Resolving the card is
       not the assertion; what reaches `create` is. */
    const d = deps({ confirmWithPreferences: vi.fn().mockResolvedValue({ approved: true, text: 'beach days, no temples' }) })
    await plan(d)
    expect(sentPreferences(d)).toBe('beach days, no temples')
  })

  it('treats a blank-looking override as blank, never as an empty string', async () => {
    /* `''` is falsy and the backend decides blank with `(explicit_text or "").strip()`. A `''` or
       `'  '` arriving as a stated preference is a run that skips recall AND remembers nothing.
       The card normalizes, and so does this — the dep is injectable and must not be trusted. */
    for (const text of ['', '   ', '\n\t ']) {
      const d = deps({ confirmWithPreferences: vi.fn().mockResolvedValue({ approved: true, text }) })
      await plan(d)
      expect(sentPreferences(d), `override ${JSON.stringify(text)}`).toBeNull()
    }
  })

  it('trims and caps the override the same way a stated preference is', async () => {
    const d = deps({ confirmWithPreferences: vi.fn().mockResolvedValue({ approved: true, text: `  ${'x'.repeat(400)}  ` }) })
    await plan(d)
    expect(sentPreferences(d)).toBe('x'.repeat(280))
  })

  it('spends nothing when the preference card is declined', async () => {
    const d = deps({ confirmWithPreferences: vi.fn().mockResolvedValue({ approved: false, text: 'beach days' }) })
    const out = JSON.parse(String(await plan(d))) as { outcome: string; decided_by: string }
    expect(d.create, 'started a trip the user refused').not.toHaveBeenCalled()
    expect(out.outcome).toBe('declined')
    expect(out.decided_by).toBe('user')
  })

  it('never reports a decline for a preference card that was never shown', async () => {
    // Same rule as the plain card: `'unavailable'` is our own value, and nobody was asked.
    const d = deps({ confirmWithPreferences: vi.fn().mockResolvedValue('unavailable') })
    const out = String(await plan(d))
    expect(d.create).not.toHaveBeenCalled()
    expect(out).toMatch(/another approval is already waiting/i)
    expect(out, 'answered for a user who was never shown a card').not.toMatch(/declined/i)
  })

  it('tells the agent when the typed answer replaced what Astrail remembers', async () => {
    /* The card said "try to recall"; the agent narrates from what this returns. Without the
       correction it tells the user their remembered preferences are being used while the run
       is built from something else entirely. */
    const d = deps({ confirmWithPreferences: vi.fn().mockResolvedValue({ approved: true, text: 'beach days' }) })
    const note = (JSON.parse(String(await plan(d))) as { note: string }).note
    expect(note).toMatch(/typed/i)
    expect(note).toMatch(/not what Astrail remembers/i)
  })

  it('says nothing about a replacement when there was none', async () => {
    const d = deps()
    const note = (JSON.parse(String(await plan(d))) as { note: string }).note
    expect(note).not.toMatch(/typed/i)
  })

  it('stays inside the tool-output budget with the correction attached', async () => {
    // The longest success this tool can return: five reels, a library line, and the correction.
    const d = deps({
      confirmWithPreferences: vi.fn().mockResolvedValue({ approved: true, text: 'beach days' }),
      saveToLibrary: vi.fn().mockResolvedValue({}),
    })
    const out = String(await plan(d, {
      reel_urls: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((s) => `https://www.instagram.com/reel/C${s}/`),
    }))
    expect(fitsBudget(out)).toBe(true)
  })
})
