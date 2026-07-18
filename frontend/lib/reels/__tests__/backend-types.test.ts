import { describe, expectTypeOf, it } from 'vitest'
import type {
  CaptureSavedReelRequest,
  CaptureSavedReelResponse,
  ReelCollection,
  ReelCollectionItem,
  ReelSourcePlatform,
  SavedReel,
  SavedReelAnalysisStatus,
} from '@/lib/reels/backend-types'

const savedReel = {
  id: 'saved-reel-id',
  user_id: 'user-id',
  normalized_url: 'https://www.instagram.com/reel/ABC123',
  source_platform: 'instagram',
  reel_cache_id: null,
  analysis_status: 'not_analyzed',
  personal_label: null,
  retry_after: null,
  analyzed_at: null,
  created_at: '2026-07-18T00:00:00Z',
  updated_at: '2026-07-18T00:00:00Z',
} satisfies SavedReel

const collection = {
  id: 'collection-id',
  user_id: 'user-id',
  name: 'Tokyo food',
  sort_order: 0,
  created_at: '2026-07-18T00:00:00Z',
  updated_at: '2026-07-18T00:00:00Z',
} satisfies ReelCollection

const collectionItem = {
  user_id: 'user-id',
  collection_id: 'collection-id',
  saved_reel_id: 'saved-reel-id',
  created_at: '2026-07-18T00:00:00Z',
} satisfies ReelCollectionItem

const captureRequest = {
  url: 'https://www.instagram.com/reel/ABC123',
} satisfies CaptureSavedReelRequest

const captureResponse = {
  saved_reel: savedReel,
} satisfies CaptureSavedReelResponse

const invalidRequest: CaptureSavedReelRequest = {
  url: 'https://www.instagram.com/reel/ABC123',
  // @ts-expect-error The authenticated backend, not the browser, owns user_id.
  user_id: 'forged-user-id',
}

const invalidAnalysisRequest: CaptureSavedReelRequest = {
  url: 'https://www.instagram.com/reel/ABC123',
  // @ts-expect-error Analysis state is owned by the backend.
  analysis_status: 'organized',
}

const invalidCacheRequest: CaptureSavedReelRequest = {
  url: 'https://www.instagram.com/reel/ABC123',
  // @ts-expect-error Cache linkage is owned by the backend.
  reel_cache_id: 'forged-cache-id',
}

describe('saved reel backend-types contract', () => {
  it('mirrors the saved Reel and collection row shapes', () => {
    expectTypeOf<SavedReel['source_platform']>().toEqualTypeOf<ReelSourcePlatform>()
    expectTypeOf<SavedReel['analysis_status']>().toEqualTypeOf<SavedReelAnalysisStatus>()
    expectTypeOf<SavedReel['reel_cache_id']>().toEqualTypeOf<string | null>()
    expectTypeOf<SavedReel['retry_after']>().toEqualTypeOf<string | null>()
    expectTypeOf<SavedReel['created_at']>().toEqualTypeOf<string>()
    expectTypeOf<ReelCollection['sort_order']>().toEqualTypeOf<number>()
    expectTypeOf<ReelCollectionItem['saved_reel_id']>().toEqualTypeOf<string>()
  })

  it('uses a url-only capture request and a typed response wrapper', () => {
    expectTypeOf<CaptureSavedReelRequest>().toMatchTypeOf<{ url: string }>()
    expectTypeOf<CaptureSavedReelResponse['saved_reel']>().toEqualTypeOf<SavedReel>()
    expectTypeOf(captureRequest).toEqualTypeOf<CaptureSavedReelRequest>()
    expectTypeOf(captureResponse).toMatchTypeOf<CaptureSavedReelResponse>()
    expectTypeOf(savedReel).toMatchTypeOf<SavedReel>()
    expectTypeOf(collection).toMatchTypeOf<ReelCollection>()
    expectTypeOf(collectionItem).toMatchTypeOf<ReelCollectionItem>()
    expectTypeOf(invalidRequest).toMatchTypeOf<CaptureSavedReelRequest>()
    expectTypeOf(invalidAnalysisRequest).toMatchTypeOf<CaptureSavedReelRequest>()
    expectTypeOf(invalidCacheRequest).toMatchTypeOf<CaptureSavedReelRequest>()
  })
})
