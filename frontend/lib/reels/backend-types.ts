export type ReelSourcePlatform = 'instagram' | 'tiktok' | 'manual'

export type SavedReelAnalysisStatus =
  | 'not_analyzed'
  | 'queued'
  | 'processing'
  | 'organized'
  | 'location_not_found'
  | 'failed'

export type SavedReel = {
  id: string
  user_id: string
  normalized_url: string
  source_platform: ReelSourcePlatform
  reel_cache_id: string | null
  analysis_status: SavedReelAnalysisStatus
  personal_label: string | null
  retry_after: string | null
  analyzed_at: string | null
  created_at: string
  updated_at: string
}

export type ReelCollection = {
  id: string
  user_id: string
  name: string
  sort_order: number
  created_at: string
  updated_at: string
}

export type ReelCollectionItem = {
  user_id: string
  collection_id: string
  saved_reel_id: string
  created_at: string
}

export type CaptureSavedReelRequest = {
  url: string
}

export type CaptureSavedReelResponse = {
  saved_reel: SavedReel
}
