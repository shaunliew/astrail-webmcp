import { createClient } from '@/lib/supabase/client'
import type {
  CaptureSavedReelResponse, OrganizeJob, OrganizeStreamEvent, SavedReelCard, StartOrganizeResponse,
} from './backend-types'

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:8000'
export const ACTIVE_ORGANIZE_CONFLICT_MESSAGE = 'One of those Reels is already being organized. Wait for it to finish, or deselect it and organize the others.'
const SAFE_SAVED_REEL_CARD_COLUMNS = [
  'id', 'user_id', 'normalized_url', 'source_platform', 'reel_cache_id',
  'analysis_status', 'personal_label', 'retry_after', 'analyzed_at',
  'created_at', 'updated_at', 'caption', 'thumbnail_url', 'has_current_cache', 'places',
].join(',')

async function backendJson<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  })
  if (!response.ok) {
    if (response.status === 409 && path === '/saved-reels/organize') {
      throw new Error(ACTIVE_ORGANIZE_CONFLICT_MESSAGE)
    }
    throw new Error(`Saved Reels request failed: ${response.status}`)
  }
  return response.json() as Promise<T>
}

export function captureSavedReel(url: string, token: string): Promise<CaptureSavedReelResponse> {
  return backendJson<CaptureSavedReelResponse>('/saved-reels', token, {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

export async function listSavedReelCards(): Promise<SavedReelCard[]> {
  const client = createClient()
  const { data: { session }, error: sessionError } = await client.auth.getSession()
  if (sessionError || !session) throw new Error('Could not load Saved Reels: not signed in')
  const { data, error } = await client.from('saved_reel_cards').select(SAFE_SAVED_REEL_CARD_COLUMNS).order('created_at', { ascending: false })
  if (error) throw new Error(`Could not load Saved Reels: ${error.message}`)
  return (data ?? []) as unknown as SavedReelCard[]
}

export function startOrganize(savedReelIds: string[], token: string): Promise<StartOrganizeResponse> {
  return backendJson<StartOrganizeResponse>('/saved-reels/organize', token, {
    method: 'POST',
    body: JSON.stringify({ saved_reel_ids: savedReelIds }),
  })
}

export function getOrganizeStatus(jobId: string, token: string): Promise<OrganizeJob> {
  return backendJson<OrganizeJob>(`/saved-reels/organize/${jobId}`, token)
}

export function streamOrganize(
  jobId: string,
  token: string,
  onEvent: (event: OrganizeStreamEvent) => void,
  onReset?: () => void,
  onFail?: () => void,
  initialCursor: string | null = null,
  onCursor?: (cursor: string) => void,
): { cancel: () => void } {
  let source: EventSource | null = null
  let cursor = initialCursor
  let consecutiveErrors = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false

  function connect() {
    if (cancelled) return
    const url = new URL(`${BACKEND_URL}/saved-reels/organize/${jobId}/stream`)
    url.searchParams.set('token', token)
    if (cursor) url.searchParams.set('cursor', cursor)
    source = new EventSource(url.toString())
    source.onopen = () => {
      consecutiveErrors = 0
      onReset?.()
    }
    source.onerror = () => {
      source?.close()
      consecutiveErrors += 1
      if (consecutiveErrors >= 5) {
        onFail?.()
        return
      }
      reconnectTimer = setTimeout(connect, Math.min(consecutiveErrors * 250, 1000))
    }
    source.onmessage = (message) => {
      if (message.lastEventId) {
        cursor = message.lastEventId
        onCursor?.(cursor)
      }
      if (message.data === '[DONE]') {
        source?.close()
        return
      }
      try {
        onEvent(JSON.parse(message.data) as OrganizeStreamEvent)
      } catch {
        // Ignore malformed frames; the durable status endpoint remains authoritative.
      }
    }
  }

  connect()
  return {
    cancel: () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      source?.close()
    },
  }
}
