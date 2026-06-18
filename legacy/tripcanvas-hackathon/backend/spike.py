"""
Phase 0 spike — verify Apify MCP + OpenAI Agents SDK wiring before production code.

Usage:
    cd backend
    uv add openai-agents openai python-dotenv
    uv run python spike.py

Set DEMO_REEL_URL in .env or export it to test a live scrape.
"""

import asyncio
import os

from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv())

from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

DEMO_REEL_URL = os.environ.get("DEMO_REEL_URL", "")


async def main() -> None:
    async with MCPServerStreamableHttp(
        name="Apify MCP Server",
        params={
            "url": "https://mcp.apify.com/?tools=actors,docs,apify/instagram-reel-scraper",
            "headers": {"Authorization": f"Bearer {os.environ['APIFY_TOKEN']}"},
            "timeout": 120,
        },
        cache_tools_list=True,
        max_retry_attempts=3,
        client_session_timeout_seconds=300,  # actor runs take 10-30s; default is 5s
    ) as server:

        # Check 1: list available tools
        tools = await server.list_tools()
        print("Available tools:", [t.name for t in tools])

        # Check 2: live scrape (only if DEMO_REEL_URL is set)
        if not DEMO_REEL_URL:
            print("\nSet DEMO_REEL_URL in .env to test a live scrape.")
            return

        agent = Agent(
            name="reel_scraper",
            instructions=(
                "You have Apify MCP tools. Follow these steps in order:\n"
                "1. Call apify--instagram-reel-scraper with {\"username\": [\"<reel URL>\"], \"resultsLimit\": 1}.\n"
                "2. From the result, get the datasetId from storages.datasets.default.id.\n"
                "3. Call get-dataset-items with that datasetId and fields=\"caption,videoUrl,audioUrl,locationName,locationId,shortCode\" and limit=1.\n"
                "4. Return ONLY the JSON object from step 3 — the actual reel data, nothing else."
            ),
            mcp_servers=[server],
        )

        result = await Runner.run(agent, DEMO_REEL_URL)
        print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
