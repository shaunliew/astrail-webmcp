import type { Breadcrumb, ErrorEvent } from '@sentry/nextjs'

const REDACTED = '[Filtered]'
const TOKEN_QUERY_RE = /([?&]token=)[^&#\s]*/gi
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
const POSTGRES_DSN_RE = /(postgres(?:ql)?:\/\/[^:/@\s]+:)[^@\s]+(@)/gi
const API_KEY_RE = /(sk-[A-Za-z0-9_-]{8,}|sk\.[A-Za-z0-9._-]{20,}|sb_secret_[A-Za-z0-9_-]{8,}|sb_publishable_[A-Za-z0-9_-]{8,}|re_[A-Za-z0-9_-]{8,}|apify_api_[A-Za-z0-9]{8,})/g

function scrubText(value: string) {
  return value
    .replace(TOKEN_QUERY_RE, `$1${REDACTED}`)
    .replace(JWT_RE, '[Filtered JWT]')
    .replace(POSTGRES_DSN_RE, `$1${REDACTED}$2`)
    .replace(API_KEY_RE, '[Filtered key]')
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) return value.map(scrubValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, scrubValue(child)]),
    )
  }
  return value
}

function stripUrlSecrets(rawUrl: string | undefined) {
  if (!rawUrl) return rawUrl

  try {
    const url = new URL(rawUrl, 'https://astrail.invalid')
    url.search = ''
    url.hash = ''
    return rawUrl.startsWith('/') ? url.pathname : url.toString()
  } catch {
    return rawUrl.split(/[?#]/, 1)[0]
  }
}

export function scrubSentryEvent(event: ErrorEvent) {
  try {
    if (event.request) {
      event.request.url = stripUrlSecrets(event.request.url)
      event.request.query_string = undefined
      event.request.cookies = undefined
      event.request.data = undefined
      event.request.env = undefined
      event.request.headers = undefined
    }

    event.server_name = undefined
    event.breadcrumbs = event.breadcrumbs
      ?.map(scrubSentryBreadcrumb)
      .filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null)
    return scrubValue(event) as ErrorEvent
  } catch {
    return null
  }
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb) {
  try {
    const scrubbed = scrubValue(breadcrumb) as Breadcrumb
    if (scrubbed.data?.url) {
      scrubbed.data.url = stripUrlSecrets(String(scrubbed.data.url))
    }
    return scrubbed
  } catch {
    return null
  }
}
