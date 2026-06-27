// TypeScript mirror of Pydantic models — keep in sync with backend/models/

export type StageEvent = {
  type: 'stage'
  stage:
    | 'scrape'
    | 'cache_hit'
    | 'extract'
    | 'enrich'
    | 'weather'
    | 'restaurants'
    | 'transport'
    | 'narrate'
    | 'summarize'
  msg: string
}

export type HeartbeatEvent = {
  type: 'heartbeat'
  elapsed_s: number
}

export type ResultEvent = {
  type: 'result'
  content: string
}

export type StreamEvent = StageEvent | HeartbeatEvent | ResultEvent

export type GenerateTripRequest = {
  reelUrls: string[]
  startDate: string
  endDate: string
  budget: string
  origin: string
  preferences: string
}

export type GenerateTripResponse = {
  tripId: string
}
