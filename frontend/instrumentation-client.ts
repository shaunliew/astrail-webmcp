import * as Sentry from '@sentry/nextjs'

import { scrubSentryBreadcrumb, scrubSentryEvent } from './sentry.shared'

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  sendDefaultPii: false,
  tracesSampleRate: 0,
  beforeSend: scrubSentryEvent,
  beforeBreadcrumb: scrubSentryBreadcrumb,
})

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
