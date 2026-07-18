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

// Browser-safe projection returned by saved_reel_cards. Raw cache payloads and
// transcripts are intentionally absent; places carry only grounded proof.
export type SavedReelPlaceProof = {
  place_id: string
  name: string
  lat: number
  lng: number
  country_code: string
  country_name: string
  evidence_quote: string
  source_url: string | null
  source_reel_url: string
  confidence: number
}

export type SavedReelCard = SavedReel & {
  caption: string | null
  thumbnail_url: string | null
  places: SavedReelPlaceProof[]
}

export type OrganizeJobStatus = 'initializing' | 'pending' | 'processing' | 'succeeded' | 'failed'
export type OrganizeItemStatus = 'queued' | 'processing' | 'organized' | 'location_not_found' | 'failed'

export type OrganizeJobItem = {
  saved_reel_id: string
  status: OrganizeItemStatus
  place_count: number
  error_message: string | null
}

export type OrganizeJob = {
  job_id: string
  status: OrganizeJobStatus
  status_message: string
  total_items: number
  processed_items: number
  organized_items: number
  location_not_found_items: number
  failed_items: number
  items: OrganizeJobItem[]
}

export type StartOrganizeResponse = { job_id: string }

export type OrganizeStage = 'queued' | 'processing' | 'grounding' | 'organize' | 'complete'
export type OrganizeStreamEvent =
  | { type: 'stage'; stage: OrganizeStage; msg: string }
  | { type: 'heartbeat'; elapsed_s: number }
  | { type: 'result'; content: string }
  | { type: 'warning' | 'error'; stage: OrganizeStage; msg: string }
