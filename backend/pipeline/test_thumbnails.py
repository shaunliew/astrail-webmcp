"""Unit tests for pipeline.thumbnails.rehost_cover — offline, credential-free, deterministic.

The download layer is faked with httpx.MockTransport (via the `transport=` test seam so production
behaviour is untouched); Supabase Storage is faked with a recording client that mimics
`client.storage.from_(bucket).upload(...)` / `.get_public_url(...)`. Every guard is asserted so
that removing it reddens a test (SSRF allowlist, deterministic-vs-transient, retry, total deadline,
non-raising boundary, CancelledError propagation).
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

import pipeline.thumbnails as thumbnails
from pipeline.thumbnails import BUCKET, _is_safe_cover_url, rehost_cover

# https + Meta-CDN host => passes _is_safe_cover_url; the signed query string mirrors a real fbcdn URL.
_SAFE_URL = "https://scontent.cdninstagram.com/v/t51/cover.jpg?stp=dst-jpg&_nc_ht=cdn"
_PUBLIC_URL = "https://proj.supabase.co/storage/v1/object/public/reel-covers/ABC123.jpg"


# --------------------------------------------------------------------------- fakes
class _RecordingBucket:
    """Records upload / get_public_url calls; optionally raises to simulate Storage failures."""

    def __init__(self, *, public_url: str = _PUBLIC_URL, upload_error=None, url_error=None):
        self.public_url = public_url
        self.upload_error = upload_error
        self.url_error = url_error
        self.uploads: list[dict] = []
        self.url_calls: list[str] = []

    async def upload(self, path, file, file_options=None):
        self.uploads.append({"path": path, "data": bytes(file), "file_options": file_options})
        if self.upload_error is not None:
            raise self.upload_error
        return {"path": path}

    async def get_public_url(self, path):
        self.url_calls.append(path)
        if self.url_error is not None:
            raise self.url_error
        return self.public_url


class _RecordingStorage:
    def __init__(self, bucket: _RecordingBucket):
        self._bucket = bucket
        self.from_ids: list[str] = []

    def from_(self, bucket_id):
        self.from_ids.append(bucket_id)
        return self._bucket


class _FakeClient:
    def __init__(self, bucket: _RecordingBucket):
        self.storage = _RecordingStorage(bucket)


class _CountingHandler:
    """MockTransport handler that counts GET calls and returns a factory-built response each call."""

    def __init__(self, response_factory):
        self._factory = response_factory
        self.calls = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        return self._factory(self.calls, request)


def _image_response(content=b"\xff\xd8\xffjpegbytes", *, status=200, content_type="image/jpeg"):
    headers = {"content-type": content_type} if content_type is not None else {}
    return httpx.Response(status, headers=headers, content=content)


def _transport(handler) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


# --------------------------------------------------------------------------- 1. success
@pytest.mark.asyncio
async def test_success_uploads_bytes_and_returns_public_url():
    bucket = _RecordingBucket()
    client = _FakeClient(bucket)
    body = b"\xff\xd8\xff" + b"realjpegpayload"

    def handler(request):
        assert str(request.url) == _SAFE_URL           # exact URL, redirects off
        return _image_response(body)

    result = await rehost_cover(client, _SAFE_URL, "ABC123", transport=_transport(handler))

    assert result == _PUBLIC_URL
    assert bucket.uploads == [{
        "path": "ABC123.jpg",
        "data": body,
        "file_options": {"upsert": "true", "content-type": "image/jpeg"},
    }]
    assert bucket.url_calls == ["ABC123.jpg"]
    assert client.storage.from_ids == [BUCKET, BUCKET]   # from_ for upload + for get_public_url


@pytest.mark.asyncio
async def test_trailing_question_mark_is_stripped():
    bucket = _RecordingBucket(public_url="https://proj.supabase.co/x/reel-covers/ABC.jpg?")
    client = _FakeClient(bucket)
    result = await rehost_cover(
        client, _SAFE_URL, "ABC",
        transport=_transport(lambda req: _image_response()),
    )
    assert result == "https://proj.supabase.co/x/reel-covers/ABC.jpg"


# --------------------------------------------------------------------------- 2. SSRF allowlist
@pytest.mark.asyncio
@pytest.mark.parametrize("bad_url", [
    "http://scontent.cdninstagram.com/cover.jpg",   # non-https scheme
    "https://evil.com/cover.jpg",                    # non-allowlisted host
    "https://169.254.169.254/cover.jpg",             # link-local IP (SSRF probe target)
    "https://cdninstagram.com.evil.com/cover.jpg",   # suffix-spoof: host does NOT end in an allowlisted suffix
])
async def test_unsafe_url_rejected_no_network_no_upload(bad_url):
    bucket = _RecordingBucket()
    client = _FakeClient(bucket)
    handler = _CountingHandler(lambda n, req: _image_response())

    result = await rehost_cover(client, bad_url, "ABC", transport=_transport(handler))

    assert result is None
    assert handler.calls == 0                     # no GET attempted at all
    assert bucket.uploads == []                   # no upload
    assert client.storage.from_ids == []          # Storage never touched


@pytest.mark.asyncio
@pytest.mark.parametrize("empty", [None, ""])
async def test_empty_display_url_returns_none(empty):
    bucket = _RecordingBucket()
    client = _FakeClient(bucket)
    handler = _CountingHandler(lambda n, req: _image_response())
    result = await rehost_cover(client, empty, "ABC", transport=_transport(handler))
    assert result is None
    assert handler.calls == 0
    assert bucket.uploads == []


def test_is_safe_cover_url_allowlist():
    assert _is_safe_cover_url("https://scontent.cdninstagram.com/x.jpg")
    assert _is_safe_cover_url("https://z.fbcdn.net/x.jpg")
    assert _is_safe_cover_url("https://fbcdn.net/x.jpg")          # bare allowlisted host
    assert not _is_safe_cover_url("http://scontent.cdninstagram.com/x.jpg")   # not https
    assert not _is_safe_cover_url("https://evil.com/x.jpg")
    assert not _is_safe_cover_url("https://169.254.169.254/x.jpg")
    assert not _is_safe_cover_url("https://fbcdn.net.evil.com/x.jpg")         # suffix spoof
    assert not _is_safe_cover_url("not a url at all")


# --------------------------------------------------------------------------- 3. 4xx (deterministic)
@pytest.mark.asyncio
async def test_4xx_returns_none_no_retry_no_upload():
    bucket = _RecordingBucket()
    client = _FakeClient(bucket)
    handler = _CountingHandler(lambda n, req: httpx.Response(404))
    result = await rehost_cover(client, _SAFE_URL, "ABC", transport=_transport(handler))
    assert result is None
    assert handler.calls == 1                      # deterministic: NOT retried
    assert bucket.uploads == []


# --------------------------------------------------------------------------- 4. non-image content-type
@pytest.mark.asyncio
async def test_non_image_content_type_returns_none():
    bucket = _RecordingBucket()
    client = _FakeClient(bucket)
    handler = _CountingHandler(lambda n, req: _image_response(b"<html>", content_type="text/html"))
    result = await rehost_cover(client, _SAFE_URL, "ABC", transport=_transport(handler))
    assert result is None
    assert handler.calls == 1
    assert bucket.uploads == []


# --------------------------------------------------------------------------- 5. oversize
@pytest.mark.asyncio
async def test_oversize_body_returns_none(monkeypatch):
    monkeypatch.setattr(thumbnails, "_MAX_BYTES", 16)
    bucket = _RecordingBucket()
    client = _FakeClient(bucket)
    handler = _CountingHandler(lambda n, req: _image_response(b"x" * 4096))   # >> cap
    result = await rehost_cover(client, _SAFE_URL, "ABC", transport=_transport(handler))
    assert result is None
    assert handler.calls == 1                      # deterministic: NOT retried
    assert bucket.uploads == []


# --------------------------------------------------------------------------- 6. empty body
@pytest.mark.asyncio
async def test_empty_body_returns_none():
    bucket = _RecordingBucket()
    client = _FakeClient(bucket)
    handler = _CountingHandler(lambda n, req: _image_response(b""))
    result = await rehost_cover(client, _SAFE_URL, "ABC", transport=_transport(handler))
    assert result is None
    assert handler.calls == 1
    assert bucket.uploads == []


# --------------------------------------------------------------------------- 7. 5xx then 200 (transient)
@pytest.mark.asyncio
async def test_5xx_then_200_is_retried_and_succeeds(monkeypatch):
    monkeypatch.setattr(thumbnails, "_BACKOFF_S", 0.001)
    bucket = _RecordingBucket()
    client = _FakeClient(bucket)

    def factory(call_n, request):
        return httpx.Response(503) if call_n == 1 else _image_response(b"ok")

    handler = _CountingHandler(factory)
    result = await rehost_cover(client, _SAFE_URL, "ABC", transport=_transport(handler))

    assert result == _PUBLIC_URL
    assert handler.calls == 2                       # retried exactly once
    assert len(bucket.uploads) == 1


# --------------------------------------------------------------------------- 8. 5xx every attempt
@pytest.mark.asyncio
async def test_5xx_every_attempt_returns_none_after_max_attempts(monkeypatch):
    monkeypatch.setattr(thumbnails, "_BACKOFF_S", 0.001)
    bucket = _RecordingBucket()
    client = _FakeClient(bucket)
    handler = _CountingHandler(lambda n, req: httpx.Response(500))
    result = await rehost_cover(client, _SAFE_URL, "ABC", transport=_transport(handler))
    assert result is None
    assert handler.calls == thumbnails._MAX_ATTEMPTS
    assert bucket.uploads == []


# --------------------------------------------------------------------------- 9. get_public_url raises (transient)
@pytest.mark.asyncio
async def test_get_public_url_raises_is_retried_then_none(monkeypatch):
    monkeypatch.setattr(thumbnails, "_BACKOFF_S", 0.001)
    bucket = _RecordingBucket(url_error=RuntimeError("storage boom"))
    client = _FakeClient(bucket)
    handler = _CountingHandler(lambda n, req: _image_response(b"ok"))
    result = await rehost_cover(client, _SAFE_URL, "ABC", transport=_transport(handler))
    assert result is None
    assert len(bucket.url_calls) == thumbnails._MAX_ATTEMPTS   # retried on the Storage error
    assert len(bucket.uploads) == thumbnails._MAX_ATTEMPTS


# --------------------------------------------------------------------------- 10. transport aclose raises
@pytest.mark.asyncio
async def test_client_aclose_failure_does_not_propagate(monkeypatch):
    monkeypatch.setattr(thumbnails, "_BACKOFF_S", 0.001)

    class _AcloseBoom(httpx.MockTransport):
        async def aclose(self):
            raise RuntimeError("aclose boom")

    bucket = _RecordingBucket()
    client = _FakeClient(bucket)
    handler = _CountingHandler(lambda n, req: _image_response(b"ok"))
    result = await rehost_cover(client, _SAFE_URL, "ABC", transport=_AcloseBoom(handler))

    assert result is None                          # swallowed, does not propagate
    assert bucket.uploads == []                    # aclose fails before the upload step


# --------------------------------------------------------------------------- 11. total deadline (slow drip)
@pytest.mark.asyncio
async def test_slow_drip_aborts_via_total_deadline_not_read_timeout(monkeypatch):
    # read-timeout LARGER than any single chunk delay => httpx's per-chunk timeout can NEVER fire;
    # only the total asyncio.timeout across the (finite) drip can end this.
    monkeypatch.setattr(thumbnails, "_TOTAL_DEADLINE_S", 0.2)
    monkeypatch.setattr(thumbnails, "_READ_TIMEOUT_S", 5.0)
    monkeypatch.setattr(thumbnails, "_BACKOFF_S", 0.001)

    def slow_drip():
        async def gen():
            for _ in range(100):                   # 100 * 0.02s = 2.0s total >> 0.2s deadline; finite so removal reddens
                await asyncio.sleep(0.02)
                yield b"x" * 8
        return gen()

    bucket = _RecordingBucket()
    client = _FakeClient(bucket)
    handler = _CountingHandler(
        lambda n, req: httpx.Response(200, headers={"content-type": "image/jpeg"}, content=slow_drip())
    )

    result = await rehost_cover(client, _SAFE_URL, "ABC", transport=_transport(handler))

    assert result is None                          # aborted mid-download by the TOTAL deadline
    assert bucket.uploads == []                    # never finished downloading => never uploaded


# --------------------------------------------------------------------------- CancelledError propagates
@pytest.mark.asyncio
async def test_cancelled_error_propagates_and_is_not_retried():
    # Make the REAL _attempt raise CancelledError (via the injected Storage upload) — it must propagate
    # out of rehost_cover (never swallowed to None) and must NOT be retried.
    bucket = _RecordingBucket(upload_error=asyncio.CancelledError())
    client = _FakeClient(bucket)
    handler = _CountingHandler(lambda n, req: _image_response(b"ok"))

    with pytest.raises(asyncio.CancelledError):
        await rehost_cover(client, _SAFE_URL, "ABC", transport=_transport(handler))

    assert len(bucket.uploads) == 1                # exactly one attempt: cancellation is not retried


def test_import_needs_no_keys(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    import importlib
    import pipeline.thumbnails as m
    importlib.reload(m)
    assert m.BUCKET == "reel-covers"
