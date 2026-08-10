import { describe, expect, it } from 'vitest'

import { scrubSentryBreadcrumb, scrubSentryEvent } from './sentry.shared'

describe('scrubSentryEvent', () => {
  it('removes URL secrets and request credentials before an event leaves Astrail', () => {
    const event = scrubSentryEvent({
      type: undefined,
      request: {
        url: 'https://astrail.xyz/auth/callback?token=secret#fragment',
        query_string: 'token=secret',
        cookies: { session: 'secret' },
        data: { private: 'secret' },
        headers: {
          Authorization: 'Bearer secret',
          Cookie: 'session=secret',
          Accept: 'text/html',
        },
      },
      breadcrumbs: [{ data: { url: '/app?token=secret#fragment', safe: 'value' } }],
    })

    expect(event?.request).toMatchObject({
      url: 'https://astrail.xyz/auth/callback',
    })
    expect(event?.request?.query_string).toBeUndefined()
    expect(event?.request?.headers).toBeUndefined()
    expect(event?.request?.cookies).toBeUndefined()
    expect(event?.request?.data).toBeUndefined()
    expect(event?.breadcrumbs?.[0]?.data).toEqual({ url: '/app', safe: 'value' })
  })

  it('redacts credential-shaped values anywhere in the event', () => {
    const event = scrubSentryEvent({
      type: undefined,
      exception: { values: [{ value: 'failed ?token=eyJabc.def.ghi' }] },
      extra: {
        postgres: 'postgres://svc:secret@db.example/postgres',
        openai: 'sk-abcdEFGH1234567890',
        supabase: 'sb_secret_AbCdEfGh12345678',
        mapbox: 'sk.eyJ1IjoibWFwYm94Ijoic2VjcmV0In0.abcdefghijklmnop',
      },
    })

    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('eyJabc.def.ghi')
    expect(serialized).not.toContain(':secret@')
    expect(serialized).not.toContain('sk-abcdEFGH1234567890')
    expect(serialized).not.toContain('sb_secret_AbCdEfGh12345678')
    expect(serialized).not.toContain('sk.eyJ1IjoibWFwYm94')
  })

  it('scrubs breadcrumb messages before they enter an event', () => {
    const breadcrumb = scrubSentryBreadcrumb({
      message: 'GET /stream?token=eyJabc.def.ghi',
    })

    expect(breadcrumb?.message).toContain('token=[Filtered]')
    expect(breadcrumb?.message).not.toContain('eyJabc.def.ghi')
  })
})
