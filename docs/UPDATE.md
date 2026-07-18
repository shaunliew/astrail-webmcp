# Astrail Product and UX Update

Last updated: 2026-07-18

This document records the product and UX direction agreed during the current redesign discussion. It is a living decision record for future design and implementation work. It supplements the existing PRD where the approved direction below differs from the older beta scope.

## 1. Product problem

Astrail is for people who save many travel Reels into Instagram folders but do not turn them into usable plans. They are not necessarily enthusiastic planners; they save inspiration and postpone the organizational and research work because it feels tedious.

Astrail should therefore do the heavy work:

1. Accept saved Reel links.
2. Extract every place mentioned in each Reel.
3. Research and verify those places.
4. Organize them into useful country and category groupings.
5. Let the user keep control over that organization.
6. Turn selected places into an efficient trip after collecting a small amount of trip context.

The core promise is not merely itinerary generation. It is turning a disorganized collection of saved travel content into organized, trustworthy, editable travel plans with very little user effort.

## 2. Experience principles

The experience should feel:

- Clean, calm, organized, and premium.
- Approachable in the way polished Apple products are approachable, without copying Apple's visual language literally.
- Simple at first glance, with complexity revealed only when the user requests it.
- Photo- and map-led instead of text-heavy.
- Helpful and intelligent without looking like a generic AI dashboard.
- Explicit about meaningful actions so the user does not accidentally change a trip.

Avoid:

- Large information dumps.
- Too many controls shown simultaneously.
- Long AI explanations that users are unlikely to read.
- Raw agent logs or technical processing language.
- A fake chatbot that only asks form questions and cannot genuinely converse.
- Unexpected changes to an itinerary.

The beta is browser-first. Phone layouts remain important as a secondary responsive experience, but an iOS application is not part of this beta. The landing page and its scroll/video treatment will be designed last, after the core product workflow is correct.

## 3. Core information architecture

The approved primary navigation has three permanent spaces:

1. **Saved Reels** - the permanent source library.
2. **Places** - researched destinations extracted from Reels.
3. **Trips** - itineraries generated from selected places.

A persistent left navigation is used on desktop. Contextual breadcrumbs communicate the user's current country tray, collection, or trip without adding more primary navigation levels.

The main **Places** navigation entry always opens the country overview. Contextual actions may open a particular country tray directly when the destination is already known.

This structure is intentionally based on three different objects:

- Reels are sources and inspiration.
- Places are verified travel candidates.
- Trips are committed plans.

They should not be collapsed into a single overloaded dashboard.

## 4. Saved Reels library

Adding Reels is separate from creating a trip. Every imported Reel first becomes part of the user's permanent Saved Reels library.

The library should support:

- Searching saved Reels.
- Viewing Reel covers prominently as visual proof of the source.
- Opening the original Reel.
- Viewing a concise caption or excerpt when useful.
- Seeing the places Astrail extracted from the Reel.
- Automatic tags such as food, hotel, theme park, shopping, or other useful categories.
- User-created collections with normal organization controls such as rename and move.
- A Reel belonging to more than one personal collection.

Each custom folder is a standalone collection with its own name and membership. Different folders may contain the same Reel. Adding a Reel to another folder creates another folder membership, not a duplicate Reel record, so the original source, extracted places, and processing state remain shared.

Removing a Reel from a folder removes only that folder membership. The Reel remains in the permanent library and in any other folders that reference it. Permanently removing the source requires a separate, explicit **Delete everywhere** action so normal organization cannot accidentally destroy shared data.

A Reel remains one source record even when it contains several places. One Reel may produce multiple place records, including places in different countries.

If no location can be confidently verified, the Reel remains visible in Saved Reels with a clear state such as **Location not found** and an **Add place manually** action. There is no permanent, separate Needs Review tray.

The desired Saved Reels dashboard direction includes:

- Search.
- A prominent **+ Add Reels** action.
- A Reels/Places view switch where useful.
- Lightweight category filters.
- Custom collections.
- A visually rich latest-saves grid.

### 4.1 Custom folders versus smart categories

Custom folders represent personally meaningful organization, such as `Anniversary ideas`, `Japan 2027`, or `Sarah's recommendations`. They contain shared references to whole Reels.

Custom folders remain flat in the browser beta. Nested folders are excluded to keep organization lightweight. Search, sorting, and optionally pinning favorite folders should provide access without introducing another hierarchy for the user to maintain.

Food, hotels, theme parks, shopping, attractions, and similar classifications are editable tags rather than ordinary folders. Astrail assigns these tags automatically to extracted places, and users can add, remove, or correct them. Category views are generated from those tags, so one place can appear in several relevant views without being duplicated.

For example, Shibuya Sky may appear under `Viewpoint`, `Attraction`, and `Night activity` while remaining one place record linked to its source Reel.

## 5. Places and country trays

Verified places are automatically grouped into country trays. This organization is handled by Astrail so the user does not need to sort every saved item manually.

Users still retain normal organizational freedom:

- Rename a tray's display name.
- Move a place.
- Create more detailed organization such as food, theme parks, or hotels.
- Correct or manually add place information.

The data model should distinguish a canonical country identity from the editable label. For example, a tray can retain canonical country code `JP` while the user renames the tray to `Tokyo ideas` or another personal label.

If the user moves a place into a tray whose canonical country does not match, Astrail should not block the action. It should immediately and politely remind the user, then preserve a noticeable state such as an **Outside Japan** chip and a tray-level count. The tone is a reminder, not a warning.

The country overview is the default Places landing screen. After a multi-country import, newly affected country trays should be visually highlighted there.

## 6. Adding Reels

### 6.1 Global action and context

**+ Add Reels** should remain globally accessible from the application shell.

Its behavior depends on context:

- From Saved Reels or Places, imported Reels update the permanent library and relevant country trays.
- From inside a trip, Astrail must explicitly offer **Add to this trip** before changing that trip.

Global import must never silently modify an existing itinerary.

When newly imported places may be relevant to an existing trip, that trip can show a subtle prompt such as:

> 3 new Japan places are available - Review for this trip

Only after the user chooses to add them should Astrail revise the route.

### 6.2 Import presentation

The approved import concept uses a slowly spinning globe as a meaningful processing canvas, not decorative loading filler.

The sequence is:

1. User pastes one or several Reel links.
2. Astrail shows curated, human-readable progress.
3. A country highlights only after a location has been researched and verified.
4. The interface reports useful discoveries, for example that Astrail found several places in Japan.
5. The user can leave the screen while processing continues.

After the user confirms **Organize selected**, the interface should transition directly to the globe. Do not hold the user on the Inbox for an extra card-processing animation.

The approved progress treatment is intentionally minimal on both desktop and mobile:

- Do not use a permanent right-side activity panel.
- Show one compact, chat-like horizontal status bar over the globe.
- Display only the current Astrail action, such as **Reading your Reels for names and location clues**, with an animated ellipsis while work is active.
- Replace the message as the pipeline advances instead of stacking a transcript of previous steps.
- At completion, turn the same bar into a concise success message before presenting the country trays.
- Explain useful verification outcomes, but never expose hidden chain-of-thought, raw agent logs, prompts, or technical traces.

The current globe illustration and dark processing palette remain design placeholders. Their visual style and final color system should be refined later without changing this interaction model.

Do not expose raw agent logs. Progress text should describe outcomes in ordinary language.

Motion must be slow and purposeful, and the experience needs a reduced-motion treatment.

### 6.3 Import completion

If exactly one country is found, the globe may enlarge or zoom into that country and reveal the verified place pins. The user can continue directly into that country tray.

If several countries are found, Astrail should show the affected country trays - for example China, Japan, and Korea - and let the user choose which one to explore first. The country overview remains available as the stable parent screen.

### 6.4 Duplicate Reel imports

Astrail automatically detects repeated Reel URLs using their normalized Instagram identity. It does not create or process another Reel record when the source is already known.

The interface should show **Already saved** and preserve the user's current intent:

- From a custom folder, offer **Add existing Reel to this folder**.
- From inside a trip, offer **Review its places for this trip** rather than silently changing the itinerary.
- If the previous extraction failed or has become stale, offer **Try extracting again**.

This duplicate handling is shared across the application. It should reuse the existing source and extracted-place data while creating only the required folder or trip relationship.

### 6.5 Low-friction capture and beta quotas

Capturing a Reel URL and performing expensive analysis are separate operations. Users may quickly save URLs into an unorganized Inbox without immediately calling Apify or an extraction agent. Reasonable storage and abuse controls may apply, but the analysis allowance should not prevent ordinary capture.

Saving never spends an analysis automatically. A globally cached Reel may organize immediately at no cost. A new uncached Reel remains in the Inbox and offers **Organize now**, clearly stating that it uses one of the five daily analyses, or **Keep for later**. For several queued Reels, Astrail can preselect the oldest eligible items and offer **Organize 5**, while allowing the user to change the selection before paid work begins.

The approved Inbox selection interaction keeps normal browsing visually clean:

- Reel cards do not display persistent checkboxes in the default state.
- **Organize Reels** enters a temporary selection mode.
- Eligible uncached Reels gain clear selection controls; already-organized cached Reels remain visible but are subdued and cannot consume an analysis.
- Astrail may preselect the oldest eligible items for convenience, while the user can freely change the selection.
- A single floating confirmation bar shows the selected count, analyses that will be consumed, allowance remaining afterward, and **Organize selected**.
- Entering selection mode does not consume usage. Paid work begins only after the confirmation action.
- Competing actions such as **Add Reels** are hidden during selection so the user has one clear task.

Inbox cards use a deliberately simple beta hierarchy:

1. An exact global cache hit may show Astrail's existing rich source card and extracted-place summary because it does not require another paid analysis.
2. A new uncached Reel shows a polished Instagram placeholder, save time, assigned folder, optional personal label, and **Open Reel**. It must be labeled **Not analyzed**.
3. After the user explicitly spends an analysis and extraction succeeds, the card can become a richer visual source card using metadata obtained through the approved extraction path.

Meta oEmbed, Meta App Review, and a separate preview-metadata integration are excluded from the browser beta. Do not scrape Instagram HTML or collect page metadata merely to decorate an uncached Inbox card. The beta bookmarklet saves only the normalized Reel URL. A richer compliant preview may be reconsidered after the core workflow is validated.

The existing Apify extraction path is legally and contractually separate from oEmbed. Before public beta, verify the selected actor and Astrail's collection, retention, and AI-processing behavior against current Instagram/Meta terms and applicable law. An Apify product listing is not by itself proof of Meta authorization. Treat this as a launch gate requiring qualified legal review, not as a frontend implementation assumption.

The approved browser-beta quotas are:

- Five new, uncached Reel extraction attempts per user per day.
- Globally cached Reels do not consume that allowance because they skip Apify and extraction.
- Three new trip generations per user per day, matching the PRD.
- Folder management, organization, viewing, and other non-generation actions do not consume either quota.
- Simple itinerary edits and deterministic route recalculation do not consume a trip generation. A complete AI regeneration consumes one of the three daily generations.

Extraction accounting is based on whether paid processing begins:

- Invalid URLs, duplicates, global cache hits, and requests rejected before Apify starts do not consume an analysis.
- Once Apify successfully reads a new Reel and extraction begins, one analysis is consumed even if no place can ultimately be verified.
- Astrail infrastructure failures refund the analysis.
- Private, deleted, or Instagram-blocked sources refund the analysis but receive a retry cooldown to prevent repeated external calls.

The current backend default of five daily trip generations must be aligned to the approved PRD limit of three during implementation.

The approved capture strategy is progressive:

1. **Paste and save:** the universal beta baseline. After copying an Instagram link, the user saves it through one prominent clipboard action in Astrail.
2. **Save to Astrail bookmarklet:** an optional browser-beta helper that sends the current Instagram Reel URL directly to the Inbox without requiring an extension store installation.
3. **Android PWA share target:** progressive enhancement on supported installed-PWA platforms. It is not required for successful use.
4. **Browser extension:** deferred until usage proves that maintaining deeper Instagram Web integration is worthwhile.

A normal website or PWA cannot insert itself into Instagram's custom desktop share modal. A future extension could inject an Astrail action, but that UI is controlled by Instagram and may change.

### 6.6 Usage visibility

The user profile menu is the permanent home for quota information. It should show two exact allowances rather than one percentage:

- Reel analyses remaining out of five, with the reset time.
- New trip generations remaining out of three, with the reset time.
- A short explanation that globally cached Reels do not use an analysis.

Quota information also appears contextually, but only when the user is about to perform or has just completed an operation that consumes quota. Examples include starting a new uncached analysis, generating a new trip, or requesting a complete AI regeneration. Show the cost before confirmation and a subtle remaining-count confirmation afterward.

Do not show usage reminders for browsing, folder management, moving Reels, viewing places, simple itinerary edits, deterministic route recalculation, or any other free action. A cached Reel should instead confirm **Already organized - no analysis used**. When the allowance reaches zero, Astrail saves new links to the Inbox and clearly states when analysis becomes available again.

## 7. From country tray to trip

The approved planning sequence is:

1. Import and research Reels.
2. Open a country tray.
3. See verified place pins before committing to a trip.
4. Choose to plan a trip from those places.
5. Answer a small number of trip questions.
6. Let the planning agents connect the selected places into an efficient route.
7. Review and edit the generated itinerary.

The user should see what Astrail found before Astrail asks for dates, budget, or travel style. This creates trust and makes the questions feel relevant rather than bureaucratic.

## 8. Trip brief questions

The current create-trip screen exposes too much information at once. Replace the large form-like experience with one focused question at a time.

The preferred presentation is a compact floating card over a full map, inspired by the focused holder treatment in the YAAY references. It should not use a large fixed side panel merely to display one question, and it should not pretend to be a chatbot.

The floating card should be approximately 480-560 px wide on desktop, with the map and selected pins remaining visible behind it. The card may grow only when a question genuinely requires more space.

The minimum brief is expected to cover:

- Dates or trip duration.
- Number and type of travelers.
- Budget and pace.
- Must-visit places or priorities.

Optional detail should stay hidden until requested. Questions should use quick, scannable choices with an escape hatch for custom input.

After the final answer, the agents begin route planning. The itinerary side panel can return after generation because it then contains enough useful, persistent information to justify its size.

## 9. Generated trip experience

The completed trip should be map- and photo-first. Avoid the word-heavy layout in the current trip-detail reference.

The primary experience should make it easy to scan:

- Daily route.
- Place order.
- Travel time or route efficiency.
- Strong place imagery.
- The originating Reel as proof or inspiration.
- Essential booking or timing information only when relevant.

Source proof should rely on the Reel cover, original link, and place imagery rather than long explanations. Reviews or other real-world evidence may be introduced where legally and technically available, but should not make the layout messy.

The user must have direct editing controls before Astrail introduces any chatbot-style trip editing. Initial controls include:

- Remove a place.
- Add a place.
- Move a place to another day.
- Replace a place.
- Lock a place or decision.
- Revise the route after changes.

After an edit, Astrail should revise the affected plan and route while respecting locked items. A chatbot agent is not required for the beta; direct manipulation is the clearer first implementation.

## 10. Hotel recommendations

Hotels should be recommended after Astrail has a tentative itinerary and understands the user's dates, group, budget, and route. The route determines sensible stay areas; hotel search should not happen as an isolated destination search.

For every necessary stay segment, show three hotel choices:

1. The top result marked **Recommended** and used as the provisional route base.
2. Two credible alternatives.

The recommended choice should explain its fit in plain language, such as proximity to the planned route, fit with the user's budget, or reduced travel time. Do not invent opaque percentage scores.

Users can select an alternative, see its route impact, and then revise the itinerary. A result is **Recommended**, never **Booked**. Astrail's beta hotel integration is discovery and comparison, not in-app booking.

For a multi-city trip, show top-three choices for each stay segment where a hotel change is genuinely necessary.

## 11. Current backend findings

These findings were verified during the design discussion and describe the current implementation, not the target state:

- `backend/scrape/apify_direct.py` currently maps the Reel URL, caption, `locationName`, shortcode, and an optional transcript. It does not preserve the complete raw Reel metadata needed for richer source cards.
- `backend/models/reel.py` currently accepts only that limited contract and ignores extra metadata.
- `backend/genagents/place_extractor.py` searches the web for candidates and drops unverified or coordinate-less places. It can return multiple places from one Reel.
- `backend/pipeline/cache.py` and the live runner already implement a global, versioned extraction cache keyed by normalized Reel URL. A hit skips both the Apify scrape and place extraction, including when a different user submits the same public Reel URL.
- `backend/pipeline/persist.py` already reuses a global `places` row when a newly extracted place matches by name or alias and is geographically close. This reuse happens after the Reel has been read and its place candidates have been extracted.
- The Supabase schema contains `location_graph_nodes` and `location_graph_edges`, but the current backend pipeline does not yet read from or write to those graph tables. They are a schema foundation rather than an active retrieval system today.
- Canonical country classification is not currently modeled. Place results contain city/address information but no dependable canonical country identity.
- Existing map parsing discards some country context, and one capture geocoder path is hardcoded to Japan.
- Current live trip generation flattens places rather than creating persistent country trays.
- `backend/genagents/hotel.py` uses Travala's hosted MCP for hotel search only; it does not book hotels.
- Current hotel search uses one location, dates, and room information, but it is not yet route-aware or multi-city aware.
- Current requests default to one adult and one room because traveler details are not populated.
- Budget and user preferences are not currently used for Travala ranking.
- Current hotel comparison is mainly price versus star rating.
- The frontend hotel panel does not currently expose all stored price information.

The target architecture must therefore add or revise contracts for source metadata, Reel-to-place relationships, canonical country grounding, persistent trays, route-aware hotel ranking, and trip revision.

### 11.1 Shared retrieval and cost strategy

The approved retrieval strategy has two distinct reuse levels:

1. **Exact Reel reuse:** a normalized Reel URL already present at the current extractor version reuses its cached scrape and extracted places. Astrail skips both Apify and place extraction, including when another user submits the same public Reel.
2. **Canonical place reuse:** a previously unseen Reel must still be read through Apify because its URL does not reveal its contents. After Astrail detects candidate names from the scraped metadata, it should resolve them against the shared canonical place store. A confident match reuses verified coordinates and reusable public research; only unmatched or ambiguous candidates require full research.

The target pipeline should separate lightweight candidate detection from expensive place research so the canonical-place lookup can happen between them. The current combined extraction agent performs web search before global place persistence and therefore cannot yet realize this second cost saving.

For the browser beta, Postgres relations are sufficient: a shared Reel cache, canonical places, and a Reel-to-place mention relationship. A separate graph database is not required. Existing `location_graph_nodes` and `location_graph_edges` may support future graph retrieval, but they should not be treated as an active optimization until runtime code reads and writes them.

Shared public source/place knowledge must remain separate from private user membership, folders, preferences, and trips. Reuse the public entity; never expose which other users saved it.

## 12. Scope changes relative to the older PRD

The agreed beta direction supersedes older assumptions that restricted trips to a very small Reel count or excluded itinerary editing.

The revised beta includes:

- A persistent Saved Reels library.
- Batch Reel ingestion, with the exact safe limit to be determined from implementation constraints.
- One-to-many Reel-to-place extraction.
- Country trays with canonical country identity and editable labels.
- Custom organization and category views.
- Direct itinerary editing and route revision.
- Route-aware top-three hotel recommendations.

Still outside the browser beta:

- Instagram account synchronization.
- Automatic import of the user's Instagram Saved collections.
- Native iOS share-sheet integration.
- In-app hotel booking.
- A general-purpose itinerary chatbot.

For the web beta, Reel URLs are pasted or otherwise submitted through the browser. Native appearance in Instagram's phone share sheet requires a future installed mobile application or platform-specific integration.

## 13. Navigation rules approved so far

The following behavior is locked:

- Saved Reels, Places, and Trips are persistent top-level spaces.
- Places opens the country overview by default.
- A one-country import may continue directly into that tray.
- A multi-country import returns to the country overview with new trays highlighted.
- Global Add Reels updates the library and country trays, not existing trips.
- Adding from inside a trip requires an explicit **Add to this trip** action.
- Existing trips can advertise newly available relevant places without silently inserting them.
- Once places are deliberately added to a trip, Astrail revises the route.

## 14. Planned implementation slices

Implementation should be incremental and reviewable. Do not create one giant redesign task. The anticipated dependency order is:

1. Saved Reels library, source metadata, Reel-to-place relationships, collections, and canonical country grounding.
2. Batch import jobs and the globe-based extraction experience.
3. Country overview, country trays, map pins, and the floating trip brief.
4. Trip-generation contracts and route planning.
5. Route-aware Travala top-three hotel recommendations.
6. Photo-first itinerary, direct editing, locked items, and route revision.
7. Responsive behavior, accessibility, motion settings, and visual-system polish.
8. Landing page and promotional motion/video treatment last.

Use one Codex Goal for one approved implementation plan, then execute that plan task by task. The first Goal should not begin until its design specification and implementation plan have been reviewed.

## 15. Open decisions and follow-up work

The following details are intentionally not yet locked:

- Exact visual design system, color palette, type scale, spacing, and component treatment.
- The batch-import limit and background-job constraints.
- Detailed custom collection behavior for places versus whole Reels.
- The exact questions and answer controls in the trip brief.
- Mobile treatment of the full map and whether a 3D globe remains appropriate on smaller devices.
- Review/evidence providers and the legal/technical rules for displaying third-party reviews.
- Exact route-impact metrics for hotel ranking.
- Multi-city hotel segmentation rules.
- Whether a genuine conversational editing agent is valuable after direct editing is proven.
- The landing-page scroll animation and Higgsfield-generated video concept.

## 16. Reference material

Design references discussed include:

- `frontend/reference/current/04-create-trip.png` - current create-trip information density to reduce.
- `frontend/reference/current/06-trip-detail.png` - current trip-detail wording and panel density to reduce.
- `frontend/reference/YAAY-showing-proof-of-extraction.jpg` - visual proof connecting Reels to extracted places.
- `frontend/reference/YAAY-file-holder.jpg` - inspiration for a focused, one-question-at-a-time floating card.
- The supplied YAAY map screenshots - inspiration for pins, Reel cards, and progressive detail over a map.
- The supplied globe screenshot - direction for the import and verified-country reveal experience.
- `.superpowers/brainstorm/1600-1784339436/content/inbox-selection-visual.html` - approved interaction reference for the clean Inbox and temporary Reel selection mode. This is a brainstorming artifact, not production frontend code.

References are inspiration, not specifications. Astrail should preserve its own calm, restrained identity and avoid copying another product's decorative excess.

## 17. Schema-first implementation decision

Supabase schema is the first active implementation workstream. UI polish, navigation,
country/city screen treatment, trip editing, and hotel presentation remain deferred until
the underlying data model is stable.

The schema will be designed and implemented in small forward-only slices. The first slice
is the permanent Saved Reels foundation:

1. `saved_reels` stores one user's saved source independently of trips and before analysis.
2. `reel_collections` stores flat, user-created folders.
3. `reel_collection_items` stores many-to-many folder membership, allowing the same Saved
   Reel to appear in several folders without duplication.
4. `reel_cache` remains global and reusable. Deleting one user's Saved Reel never deletes
   the shared cache row or another user's membership.
5. All three new user-owned tables require owner-enforced RLS, indexed foreign keys,
   explicit delete behavior, atomic duplicate handling, and pgTAP database tests.

The approved design source for this slice is
`docs/superpowers/specs/2026-07-18-saved-reels-schema-foundation-design.md`. The migration
was applied only after that design and its implementation plan had been reviewed.

## 18. Saved Reels schema foundation implementation receipt

Project #1 card: `Backend P1: Saved Reels schema foundation (Slice 1)`
(`PVTI_lADOEXlARc4BanGszgzQZJw`).

The first schema slice is implemented locally on `zh` through forward-only migration
`supabase/migrations/20260718120000_saved_reels_foundation.sql`. It adds the permanent
user-owned Saved Reels library, flat custom collections, safe many-to-many memberships,
owner-enforced RLS, and the service-role-only atomic `capture_saved_reel` RPC.

The backend endpoint is authenticated `POST /saved-reels`. It accepts only
`{ "url": string }`, derives ownership from the verified JWT, normalizes the Instagram
Reel URL, and returns `{ "saved_reel": SavedReel }`. It does not start extraction,
Apify, agents, usage counters, or trip generation.

Deletion behavior is now explicit: removing an item from a folder deletes only that
membership; deleting a folder preserves Saved Reels; Delete everywhere removes only the
current user's Saved Reel and memberships; and a shared `reel_cache` row or another
user's Saved Reel survives. Cache deletion sets a Saved Reel reference to null.

Verification completed locally:

- `supabase db reset` passed.
- `supabase test db` passed: 218 tests.
- `supabase db lint` passed with no schema errors.
- Full backend tests passed: 471 passed, 7 opt-in skips. Windows denied pytest's default
  temp directory, so the approved rerun used a unique repository-local `--basetemp`; no
  test was skipped or waived.
- The local real-client PostgREST RPC smoke passed: 1 test.
- Frontend typecheck passed; frontend tests passed: 37 files, 142 tests.
- The unchanged frontend production build passed on the controller's network-capable
  rerun (Next.js 15.5.19; 10/10 static pages). The initial sandbox retry could not
  download Google-hosted `next/font` assets and was an environment restriction; the only
  remaining build message was the pre-existing Supabase Edge Runtime warning.

No remote migration or deployment occurred. Saved Reels UI, safe cover/caption source
cards, extraction jobs, country/city grounding, trip integration, and hotel work remain
deferred to later slices.
