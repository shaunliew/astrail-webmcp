"""Best-effort re-host of a reel cover into public Supabase Storage. Live-only — never on the offline eval
path. Apify's displayUrl is a signed CDN URL that expires in hours/days, so we download it once at scrape time
and re-host to a stable public URL. NEVER raises (except asyncio.CancelledError, which propagates) — every
failure degrades to None (guardrail #3). Untrusted URL: https + Meta-CDN host allowlist, redirects OFF (SSRF);
streamed size cap; a TOTAL asyncio deadline across retries. Transient failures retry in-run using the
still-fresh URL (no extra Apify call)."""
from __future__ import annotations

import asyncio
import sys

import httpx

BUCKET = "reel-covers"
_MAX_BYTES = 8 * 1024 * 1024        # 8 MB cap on untrusted content
_READ_TIMEOUT_S = 5.0               # per-attempt httpx timeout
_TOTAL_DEADLINE_S = 10.0            # hard ceiling ACROSS all retries (real total, not httpx read-timeout)
_MAX_ATTEMPTS = 3
_BACKOFF_S = 0.4
_ALLOWED_HOST_SUFFIXES = (".cdninstagram.com", ".fbcdn.net")


def _is_safe_cover_url(url: str) -> bool:
    """https + Meta-CDN host only — blocks SSRF to loopback / link-local / internal hosts."""
    try:
        parsed = httpx.URL(url)
    except Exception:
        return False
    if parsed.scheme != "https":
        return False
    host = (parsed.host or "").lower()
    return any(host == s.lstrip(".") or host.endswith(s) for s in _ALLOWED_HOST_SUFFIXES)


async def _attempt(client, display_url: str, path: str, *, transport: httpx.BaseTransport | None = None) -> str | None:
    """One download+upload attempt. Returns the public URL, or None on a DETERMINISTIC reject
    (non-image, oversize, 4xx). Raises on a TRANSIENT failure (network error, 5xx, Storage error)
    so the caller retries. Constructs its own httpx client INSIDE the guarded caller. `transport` is a
    test seam (httpx.MockTransport); None => the real network transport (production)."""
    async with httpx.AsyncClient(transport=transport, timeout=_READ_TIMEOUT_S, follow_redirects=False) as http:
        async with http.stream("GET", display_url) as resp:
            if resp.status_code // 100 == 5:
                resp.raise_for_status()                 # transient → retry
            if resp.status_code // 100 != 2:
                return None                              # 4xx → deterministic, give up
            if not resp.headers.get("content-type", "").startswith("image/"):
                return None                              # deterministic
            buf = bytearray()
            async for chunk in resp.aiter_bytes():
                buf.extend(chunk)
                if len(buf) > _MAX_BYTES:
                    return None                          # deterministic
    if not buf:
        return None
    await client.storage.from_(BUCKET).upload(
        path, bytes(buf), file_options={"upsert": "true", "content-type": "image/jpeg"}
    )
    url = await client.storage.from_(BUCKET).get_public_url(path)
    return (url[:-1] if url and url.endswith("?") else url) or None


async def rehost_cover(
    client, display_url: str | None, cover_key: str, *, transport: httpx.BaseTransport | None = None
) -> str | None:
    """Re-host the cover at `<cover_key>.jpg` in the public bucket. Return the stable public URL or None.
    Never raises except CancelledError. Retries transient failures in-run (no Apify). Total-deadline bounded.
    `transport` is a test seam threaded into `_attempt`; production callers pass nothing (real network)."""
    if not display_url or not _is_safe_cover_url(display_url):
        return None
    path = f"{cover_key}.jpg"
    try:
        async with asyncio.timeout(_TOTAL_DEADLINE_S):
            for attempt in range(1, _MAX_ATTEMPTS + 1):
                try:
                    return await _attempt(client, display_url, path, transport=transport)
                except Exception as exc:                 # transient — CancelledError is BaseException, not caught
                    if attempt == _MAX_ATTEMPTS:
                        print(f"  [cover] gave up {cover_key} after {attempt}: {type(exc).__name__}", file=sys.stderr)
                        return None
                    await asyncio.sleep(_BACKOFF_S * attempt)
    except Exception as exc:                              # total-deadline (TimeoutError) or anything unforeseen
        print(f"  [cover] aborted {cover_key}: {type(exc).__name__}", file=sys.stderr)
        return None
    return None
