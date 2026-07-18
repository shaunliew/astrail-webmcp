# Saved Reels Trustworthy Global Location Grounding Design

> Astrail accepts successfully researched Reel places worldwide, but renders a pin only when sourced research coordinates and an independent Mapbox country check agree. Users are never asked to repair the pipeline.

**Status:** Approved in the 2026-07-18 design conversation.

## Goal

Any successfully researched Reel place, including places in China, Japan, and Korea, must be pinned at its sourced coordinates and grouped under the correct country. Japan is the launch-quality benchmark, not a hard geographic restriction.

“Worldwide” means Astrail accepts any country when the Reel contains enough evidence to identify a place. It does not mean locationless or unidentifiable content can always produce a pin.

## Confirmed failure

For `https://www.instagram.com/reel/DYGH3jFBZHz`, Apify and the research extractor correctly returned Tokyo, Japan and sourced Tokyo coordinates for Harry Potter Cafe. The organizer then sent a global English POI query to Mapbox Search Box, accepted a same-name result in Mexicali, Mexico, overwrote the research coordinates, and cached/persisted Mexico. The tray correctly rendered the poisoned backend value.

The bug is therefore the authority boundary: Search Box was allowed to replace researched geography even though `proximity` is only a ranking bias.

## Product and provider constraints

- Every visible place requires a Reel evidence quote, source URL, valid coordinates, confidence, and structured country.
- Research proposes a candidate; deterministic code decides whether it may appear.
- Mapbox GL JS remains the 3D rendering canvas and can render any valid longitude/latitude.
- Mapbox Search Box provides POI search, but its public geographic coverage does not provide a dependable global POI contract for China and Korea. It is also temporary-use data unless Astrail obtains separate storage rights.
- Mapbox Geocoding v6 reverse lookup is the appropriate server-side administrative check: given coordinates, request `types=country` and compare the returned ISO country code with research.
- Stored Mapbox administrative results must use `permanent=true`; shipping is blocked until the Mapbox account permits permanent geocoding.
- A live 2026-07-18 preflight with the configured backend token returned HTTP 200 and the expected `JP`, `CN`, and `KR` country contexts for Tokyo, Shanghai, and Seoul using permanent Geocoding v6.
- Google Places remains excluded: its standard policy does not permit Places results to be displayed in conjunction with a non-Google map, and its caching model conflicts with Astrail’s persistent place graph.
- No visual redesign, user correction workflow, or new provider belongs in this repair. One additive trust-gate migration hides legacy Search Box-derived organizer data and allows terminal-job reprocessing; a separate cleanup migration invalidates legacy cache payloads and removes only untrusted links.

## Selected architecture

```text
Instagram Reel
  -> Apify metadata
  -> research extractor
     name, evidence quote, source URL, sourced lat/lng,
     country_code, country_name, address/region
  -> deterministic candidate validation
     evidence is verbatim; source is real; coords valid; country pair valid
  -> Mapbox Geocoding v6 reverse country check
     longitude=<research lng>
     latitude=<research lat>
     types=country
     language=en
     permanent=true
  -> compare ISO codes
     match    -> persist research place with Mapbox's canonical country label,
                 stamp verified mention, show pin/tray
     mismatch -> reject candidate; never persist or display it
     outage   -> retry the provider once, then fail safely; never silently accept
  -> Mapbox GL renders the research coordinates
```

### Authority rules

1. Apify is a source of Reel metadata and clues, not geographic authority.
2. The research extractor is the POI identity and coordinate source because it can cite the Reel and live web evidence globally.
3. Mapbox Geocoding v6 is an independent country-containment verifier.
4. Mapbox GL is the renderer.
5. Mapbox Search Box is not used by the Saved Reels organizer. Other existing uses, such as nearby restaurant discovery, remain unchanged.
6. Research proposes `country_code` and `country_name`. After the ISO code agrees, the persisted/tray country code and English display name come from the same Mapbox reverse-country result; untrusted research text cannot control the tray label.
7. A `mapbox-country-v1` mention stamp is the read-side trust boundary. Pre-fix mentions have no stamp and are never exposed by `saved_reel_cards` or place authorization.

### Research contract

`PlaceResult` gains optional `country_code` and `country_name` so existing trip/eval consumers stay compatible. New extractor output must always include both fields together:

- `country_code`: uppercase ISO 3166-1 alpha-2;
- `country_name`: nonblank researched display name.

The Saved Reels organizer requires the pair. Missing or malformed country metadata rejects the candidate before any Mapbox request.

The extractor version is `2026-07-18.3`. Public Reel text first passes a serial deterministic Agents SDK input guardrail, before the web-search-enabled extractor can run. `reel_cache` is one row per normalized URL, so a new extraction overwrites the stale cached payload rather than retaining version history. Audit history is not claimed by this repair.

### Reverse-country verification

Add a dedicated Mapbox Geocoding v6 adapter separate from the Search Box adapter. It accepts only research coordinates and returns a normalized country code/name. It must:

- call `/search/geocode/v6/reverse`;
- send `types=country`, `limit=1`, `language=en`, and `permanent=true`;
- preserve the existing token-safety rule: never log URLs or propagate URL-bearing HTTP exceptions;
- return `None` only for a well-formed empty feature collection;
- raise a sanitized provider exception for network, authorization, billing, server, invalid-JSON, and malformed-schema errors;
- parse country metadata defensively.

A returned country mismatch is a candidate rejection. A provider exception is a retryable organizer failure, not `location_not_found`, because the place was not disproved.

Disputed-boundary worldview policy is deferred; the first acceptance matrix uses undisputed mainland coordinates in Japan, China, and South Korea.

### Cache and persistence

`reel_cache.extracted_places` stores original research output before geographic verification. It never stores Search Box-mutated coordinates. This preserves the current evidence payload and allows country verification to retry without another paid Apify/research call.

Only candidates whose research and reverse-country ISO codes match are inserted/reused in `places` and linked through `reel_place_mentions` with `verification_version = 'mapbox-country-v1'`. The safe card view and server authorization ignore unstamped legacy mentions immediately after migration.

The trust gate and cleanup are separate migrations so cleanup failure cannot roll back verified-only reads. Cleanup briefly locks only `reel_cache` and `reel_place_mentions`, invalidates cached extraction payloads for every legacy organizer mention, removes those unstamped links, then makes the verification stamp required so old code cannot recreate an untrusted link. It deliberately preserves shared `places` and location-graph rows because an unstamped mention does not prove the place was created by the legacy organizer; provenance-based physical deletion requires a separate audit.

Reprocessing replaces a Reel cache row's current mention set with the newly verified set. Place reuse requires country, exact canonical name, and geographic proximity under 500 metres; a same-name branch farther away gets its own row so the pin keeps the researched coordinates. Reusing a nearby row refreshes its country fields from the successful Mapbox result, so a stale display label cannot reappear.

Organize-job idempotency applies only while an identical request is initializing, pending, or processing. Partial initialization becomes replaceable after 120 seconds, and single-process startup requeues interrupted processing work immediately. A terminal success or failure may create a new attempt, which is required both for provider recovery and for versioned reprocessing of the exact poisoned Reel.

### User-visible failure behavior

- Candidate lacks evidence, coordinates, or country: reject that candidate.
- Research country and reverse country disagree: reject that candidate.
- No candidates survive: `location_not_found`; return to the inbox with a visible retry message and no empty tray.
- Mapbox verification unavailable: retry the HTTP request once, then mark this attempt failed with a safe verification-unavailable message; a later Organize action creates a new attempt without asking the user to correct data.
- No manual correction prompt is added. The system either verifies the place or reports that it could not verify it.

## Mapbox capability audit

Already used by Astrail:

- Mapbox GL JS / Standard 3D rendering;
- Search Box forward POI lookup;
- Search Box category lookup for restaurants;
- Directions API for route legs.

Relevant capability currently missed:

- Geocoding v6 reverse lookup with permanent administrative results — selected for country verification.

Useful later, but not part of this repair:

- `bbox` hard constraints for optional POI enrichment;
- Matrix API for many-to-many travel times;
- Optimization API for flexible stop ordering;
- Isochrone API for travel-time reachability;
- Map Matching for GPS traces;
- Mapbox Boundaries plus point-in-polygon for high-volume offline containment.

## Acceptance criteria

- A Japan research fixture with Tokyo coordinates and `JP` verifies and persists as Japan.
- A China fixture with Shanghai coordinates and `CN` verifies and persists as China.
- A Korea fixture with Seoul coordinates and `KR` verifies and persists as South Korea.
- A Tokyo research candidate paired with a Mapbox `MX` result is rejected and never persisted.
- A Mapbox outage does not fall back to unverified persistence.
- The extraction cache retains research coordinates/country, not provider-mutated data.
- Legacy unstamped Mexico/United States mentions are hidden as soon as the trust-gate migration is applied.
- Reprocessing replaces stale mention links with only the newly verified set.
- Same-name places in one country more than 500 metres apart keep distinct place rows and researched pins.
- The exact Harry Potter Cafe Reel produces a Japan tray and Tokyo pin.
- A second terminal job for the exact Reel reuses cached research output and performs no Apify extraction.
- The frontend renders only the current organize action's verified places, preserves their source Reel into the brief, and shows explicit retryable failure/zero-result states.
- Production CSP permits the narrow WebAssembly evaluation required by Mapbox Standard/3D.

## Non-goals

- Guaranteeing a result for Reels with no usable location evidence.
- Manual correction or “needs review” UI.
- Visual globe/tray polish.
- Google Maps or Google Places.
- A second POI provider.
- Broader retention cleanup for unrelated place/cache rows that were never linked by the Saved Reels organizer.
- Disputed-border worldview product policy.

## Risk and rollback

The primary risk is lower recall when research and Mapbox disagree. That is intentional: a missing pin is preferable to a confidently wrong country. Apply the trust migration before application code. The trust filter must not be rolled back while unstamped rows exist; rolling application code back while keeping the filter is fail-closed. Restoring the previous extractor version would reactivate old cache semantics, so rollback must explicitly keep those rows invalidated.
