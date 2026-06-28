# Japan Beta Eval Input Template

Use this file to collect the real Japan examples for issue #16:
`Backend P0: offline eval set for Japan beta planning`.

Purpose:
- Capture real beta-like inputs before implementation.
- Record what legacy TripCanvas/Astrail does poorly on each case.
- Give the offline eval runner concrete expected behavior to test.
- Keep v1 beta scope Japan-first, evidence-first, and memory-aware.

## V1 Beta Scope Confirmation

For v1 beta, the backend agent should support:
- Japan-first itinerary planning, with Tokyo as the primary demo/eval market.
- 1-5 Instagram Reel URLs, requested places, or both.
- Optional dates, budget, origin city, and free-text preferences.
- mem0-backed user preference memory for returning users.
- Evidence-backed places, recommendations, route notes, and tradeoffs.
- Partial success when non-critical enrichment fails.

Out of scope for v1 beta:
- Booking or payment.
- Flights.
- Instagram account import or saved collection sync.
- Full itinerary editing chat.
- Google Places, Convex, Clerk, or hackathon-era payment/booking flows.

## Memory Scope For V1

Minimum memory facts worth using in v1:
- Budget style: budget, mid-range, luxury, or flexible.
- Pace: relaxed, balanced, or packed.
- Food preference: cuisine/style, such as ramen, cafes, vegetarian, local food.
- Transport tolerance: walkable, okay with transfers, avoid long walks.
- Avoidances: not too rushed, avoid nightlife, avoid theme parks, dietary restrictions.

For the first implementation, treat budget style and pace as required memory dimensions.
Food preference and avoidances should be included when known because they strongly affect Japan recommendations.

Do not store:
- Raw full trip history as memory.
- Sensitive personal details.
- One-off trip details unless they reveal a stable preference.

## Case 1: First-Time Tokyo Trip

### User Input

- Reel URLs:
  - https://www.instagram.com/reel/DYbmT-SNzVK/
  - https://www.instagram.com/reel/DYM_I5IvLSv/
  - https://www.instagram.com/reel/DYGH3jFBZHz/
  - https://www.instagram.com/reel/DXwcVVliX3B/
- Requested places:
  - 
- Destination hint:
- Dates or duration:
- Budget:
- Origin city:
- Free-text preferences:

### Expected Good Result

- Must include:
  - 
- Should avoid:
  - 
- Good day structure:
  - 
- Good recommendations:
  - 

### Known Legacy Weakness To Record

- Extraction weakness:
- Place/recommendation weakness:
- Route/feasibility weakness:
- Evidence weakness:
- Latency weakness:
- Memory weakness, if any:

### Demo Reel URL Fixture

```json
{
  "reel_1": "https://www.instagram.com/reel/DYbmT-SNzVK/",
  "reel_2": "https://www.instagram.com/reel/DYM_I5IvLSv/",
  "reel_3": "https://www.instagram.com/reel/DYGH3jFBZHz/",
  "reel_4": "https://www.instagram.com/reel/DXwcVVliX3B/"
}
```

Use the generated output from these reels as the first eyeballed baseline.
After running the legacy/current pipeline, record:
- extracted places.
- missed places.
- hallucinated or weak-evidence places.
- route/itinerary quality problems.
- latency.
- what the improved v1 beta agent should do better.

## Case 2: Returning User With Memory

### Saved Preference Memory

- Budget style:
- Pace:
- Food preference:
- Transport tolerance:
- Avoidances:

### Current User Input

- Reel URLs:
  - 
  - 
- Requested places:
  - 
- Destination hint:
- Dates or duration:
- Budget:
- Origin city:
- Free-text preferences:

### Expected Good Result

- Memory should influence:
  - 
- Explicit current input should override memory if:
  - 
- Must include:
  - 
- Should avoid:
  - 

### Known Legacy Weakness To Record

- Extraction weakness:
- Place/recommendation weakness:
- Route/feasibility weakness:
- Evidence weakness:
- Latency weakness:
- Memory weakness:

## Case 3: Food-Heavy Osaka/Kyoto Trip

### User Input

- Reel URLs:
  - 
  - 
- Requested places:
  - 
- Destination hint:
- Dates or duration:
- Budget:
- Origin city:
- Free-text preferences:

### Expected Good Result

- Must include:
  - 
- Food recommendation expectation:
  - 
- Route/area clustering expectation:
  - 
- Should avoid:
  - 

### Known Legacy Weakness To Record

- Extraction weakness:
- Place/recommendation weakness:
- Route/feasibility weakness:
- Evidence weakness:
- Latency weakness:
- Memory weakness, if any:

## Case 4: Family-Friendly Trip

### User Input

- Reel URLs:
  - 
  - 
- Requested places:
  - 
- Destination hint:
- Dates or duration:
- Budget:
- Origin city:
- Free-text preferences:

### Expected Good Result

- Must include:
  - 
- Should be family-friendly because:
  - 
- Pace expectation:
  - 
- Should avoid:
  - 

### Known Legacy Weakness To Record

- Extraction weakness:
- Place/recommendation weakness:
- Route/feasibility weakness:
- Evidence weakness:
- Latency weakness:
- Memory weakness, if any:

## Case 5: Weather Or Rain-Constrained Trip

### User Input

- Reel URLs:
  - 
  - 
- Requested places:
  - 
- Destination hint:
- Dates or duration:
- Budget:
- Origin city:
- Free-text preferences:

### Expected Good Result

- Weather constraint:
  - 
- Indoor/flexible alternatives:
  - 
- Route/area clustering expectation:
  - 
- Should avoid:
  - 

### Known Legacy Weakness To Record

- Extraction weakness:
- Place/recommendation weakness:
- Route/feasibility weakness:
- Evidence weakness:
- Latency weakness:
- Memory weakness, if any:

## Eval Checks Issue #16 Should Support

Active checks for the first eval baseline:
- Input is valid: at least one Reel URL or one requested place.
- Output has valid itinerary JSON shape.
- Every visible place has evidence or trusted source metadata.
- Every visible place has valid coordinates when it appears on the map.
- Day count matches the requested date range or duration.
- Itinerary is not obviously overpacked.
- Known legacy weaknesses are recorded per case.
- Runner reports pass/fail and timing per case.

Pending checks to define but not block on yet:
- mem0 memory retrieval and explicit-overrides-memory behavior.
- Mapbox Search/Directions quality.
- Restaurant relevance.
- Hotel/base reasoning.
- Live Apify extraction accuracy.
- Langfuse/OpenAI trace grouping.
