"""Supabase JWT validation for authenticated FastAPI endpoints.

Verifies the Supabase-issued access token (HS256, signed with
SUPABASE_JWT_SECRET) on every request and returns the authenticated user id.
See CLAUDE.md guardrails #5 (auth on every endpoint) and #6 (owner check).
"""


# TODO: verify the bearer token with SUPABASE_JWT_SECRET and return the user id.
async def get_current_user_id(authorization: str | None) -> str:
    """Validate the Supabase JWT and return the user id; raise on invalid token."""
    raise NotImplementedError
