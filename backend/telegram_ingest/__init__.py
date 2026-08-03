"""telegram_ingest — Telegram group bot that ingests Instagram Reel URLs.

Named `telegram_ingest`, never `telegram`: `python-telegram-bot` installs as a top-level
`telegram` module, and a local `telegram/` package would shadow it with `backend/` as cwd.
The repo already carries that scar once — `genagents/` exists because the OpenAI Agents SDK
shadowed a local `agents/`.

Import-safe: no module here reads an env var, imports a heavy SDK, or touches the network
at import time.
"""
