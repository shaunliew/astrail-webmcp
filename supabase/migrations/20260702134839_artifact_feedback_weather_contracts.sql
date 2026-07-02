alter table public.trip_days
add column weather_summary text,
add column weather_source text,
add column weather_payload jsonb not null default '{}'::jsonb,
add constraint trip_days_weather_source_check check (
  weather_source is null
  or weather_source in ('open_meteo', 'manual', 'none')
),
add constraint trip_days_weather_payload_object_check check (
  jsonb_typeof(weather_payload) = 'object'
);

comment on column public.trip_days.weather_summary is
  'Per-day user-visible weather note for the saved itinerary.';

comment on column public.trip_days.weather_source is
  'Weather source for the saved itinerary day, usually open_meteo.';

comment on column public.trip_days.weather_payload is
  'Structured weather output for the saved itinerary day. Store Open-Meteo details here; do not use this as a global weather cache.';

alter table public.trip_places
add constraint trip_places_evidence_json_object_check check (
  jsonb_typeof(evidence_json) = 'object'
);

comment on column public.trip_places.evidence_json is
  'Trip-specific visible place evidence contract. Include confidence, sourceUrl or trusted tool metadata, evidence quote or rationale, and source type.';

drop policy feedback_insert_own_trip on public.feedback;

create policy feedback_insert_own_trip
on public.feedback
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.trips
    where trips.id = feedback.trip_id
      and trips.user_id = (select auth.uid())
  )
  and (
    (
      artifact_type = 'trip'
      and artifact_id is null
    )
    or (
      artifact_type = 'place'
      and artifact_id is not null
      and exists (
        select 1
        from public.trip_places
        where trip_places.trip_id = feedback.trip_id
          and trip_places.place_id = feedback.artifact_id
      )
    )
    or (
      artifact_type = 'transport_leg'
      and artifact_id is not null
      and exists (
        select 1
        from public.transport_legs
        where transport_legs.trip_id = feedback.trip_id
          and transport_legs.id = feedback.artifact_id
      )
    )
    or (
      artifact_type = 'restaurant_suggestion'
      and artifact_id is not null
      and exists (
        select 1
        from public.restaurant_suggestions
        where restaurant_suggestions.trip_id = feedback.trip_id
          and restaurant_suggestions.id = feedback.artifact_id
      )
    )
    or (
      artifact_type = 'hotel_suggestion'
      and artifact_id is not null
      and exists (
        select 1
        from public.hotel_suggestions
        where hotel_suggestions.trip_id = feedback.trip_id
          and hotel_suggestions.id = feedback.artifact_id
      )
    )
    or (
      artifact_type = 'generation_event'
      and artifact_id is not null
      and exists (
        select 1
        from public.generation_events
        where generation_events.trip_id = feedback.trip_id
          and generation_events.id = feedback.artifact_id
      )
    )
  )
);
