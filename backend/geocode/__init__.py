"""geocode — Mapbox Search Box forward-geocoding utilities.

Provides forward_geocode() for resolving a place name string to canonical
lat/lng/formatted_address via the Mapbox Search Box /forward endpoint.
apply_geocode() is a pure immutable transform that overrides a PlaceResult's
coords on a Mapbox hit and leaves them unchanged on a miss (graceful fallback).

No network calls are made at import time; a MAPBOX_SECRET_TOKEN is required
only at call time (used by the capture command; offline tests mock httpx).
"""
