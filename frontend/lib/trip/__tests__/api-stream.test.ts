import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamGeneration } from '@/lib/trip/api'

class FakeEventSource {
  static last: FakeEventSource | null = null
  url: string
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeEventSource.last = this
  }
  close() {
    this.closed = true
  }
}

function start() {
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
  const onEvent = vi.fn()
  const onReset = vi.fn()
  const onFail = vi.fn()
  const handle = streamGeneration('trip-1', 'token', onEvent, onReset, onFail)
  return { handle, es: FakeEventSource.last!, onEvent, onReset, onFail }
}

describe('streamGeneration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    FakeEventSource.last = null
  })

  it('parses events and closes on [DONE]', () => {
    const { es, onEvent } = start()
    es.onmessage!({ data: '{"type":"stage","stage":"scrape","msg":"scraping 2 reel(s)"}' })
    es.onmessage!({ data: '[DONE]' })
    expect(onEvent).toHaveBeenCalledWith({ type: 'stage', stage: 'scrape', msg: 'scraping 2 reel(s)' })
    expect(es.closed).toBe(true)
  })

  it('fires onReset on every open (reconnect replays all events)', () => {
    const { es, onReset } = start()
    es.onopen!()
    es.onopen!()
    expect(onReset).toHaveBeenCalledTimes(2)
  })

  it('closes and fires onFail after 5 consecutive errors (dead backend)', () => {
    const { es, onFail } = start()
    for (let i = 0; i < 5; i += 1) es.onerror!()
    expect(es.closed).toBe(true)
    expect(onFail).toHaveBeenCalledTimes(1)
  })

  it('a successful open resets the consecutive-error counter', () => {
    const { es, onFail } = start()
    for (let i = 0; i < 4; i += 1) es.onerror!()
    es.onopen!()
    for (let i = 0; i < 4; i += 1) es.onerror!()
    expect(onFail).not.toHaveBeenCalled()
  })

  it('skips malformed lines without throwing', () => {
    const { es, onEvent } = start()
    es.onmessage!({ data: 'not-json' })
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('cancel closes the stream', () => {
    const { handle, es } = start()
    handle.cancel()
    expect(es.closed).toBe(true)
  })
})
