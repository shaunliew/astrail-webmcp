"""Pytest config — gate live (real API) tests behind --run-live.

By default the whole suite is offline + credential-free. Tests marked
`@pytest.mark.live` make real OpenAI/Apify calls and are skipped unless
`pytest --run-live` is passed (and the relevant keys are present).
"""
import pytest


def pytest_addoption(parser):
    parser.addoption(
        "--run-live",
        action="store_true",
        default=False,
        help="run @pytest.mark.live tests (real OpenAI/Apify calls)",
    )


def pytest_collection_modifyitems(config, items):
    if config.getoption("--run-live"):
        # Live tests need real keys — load backend/.env so APIFY_TOKEN / OPENAI_API_KEY
        # are present. ONLY here: the default (offline) suite never loads .env, so it
        # stays credential-free and proves the modules need no key.
        from dotenv import find_dotenv, load_dotenv
        load_dotenv(find_dotenv())
        return
    skip_live = pytest.mark.skip(reason="needs --run-live (real API calls)")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip_live)
