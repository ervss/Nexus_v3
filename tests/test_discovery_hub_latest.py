"""Exercise the actual route with HTTP fixtures, without starting app workers."""
import ast
import asyncio
import logging
import os
from pathlib import Path
import re
from typing import Any, Dict, List, Optional
import urllib.parse

import aiohttp
import pytest


@pytest.mark.parametrize("mode", ["latest", "search"])
@pytest.mark.parametrize("page", [1, 2])
@pytest.mark.parametrize("query", ["  ", " BBC ", "BBC & studio"])
def test_latest_uses_balbums_order_and_real_pagination(monkeypatch, mode, page, query):
    requests = []
    # The first album intentionally has fewer files and no preview. Neither
    # popularity nor preview availability should move the second album ahead.
    html = f'''<div>Page {page} of 2</div>
        <a class="card" href="https://bunkr.cr/a/newest"><h3>Newest</h3>1 files</a>
        <a class="card" href="https://bunkr.cr/a/older"><h3>Older</h3>900 files
            <img class="thumb-img" src="https://cdn.example/older.jpg"></a>
        <a href="/?page=2">Next</a>'''

    from app.discovery_hub_runtime import HubResponse
    import app.discovery_hub_runtime as runtime
    async def get(url, **kwargs):
        requests.append(url)
        assert url.startswith("https://balbums.st/")
        assert kwargs["timeout"] == 22  # slow complete listings must survive the old 6s cutoff
        return HubResponse(200, html)
    monkeypatch.setattr(runtime, "hub_get", get)
    tree = ast.parse(Path("app/main.py").read_text(encoding="utf-8"))
    route = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "discovery_hub_bunkr")
    route.decorator_list = []
    # Run the production route/parser, stubbing only item formatting helpers.
    namespace = dict(__name__="app.main", asyncio=asyncio, logging=logging, os=os, re=re,
                     urllib=urllib, Any=Any, Dict=Dict, List=List, Optional=Optional,
                     _dh_clean_album_title=lambda value: value,
                     _dh_absolute_url=urllib.parse.urljoin,
                     _dh_pick_first_date=lambda value: value,
                     _dh_canonical_url=lambda value: value,
                     _dh_make_item=lambda **kwargs: dict(kwargs, type=kwargs["item_type"]))
    exec(compile(ast.Module(body=[route], type_ignores=[]), "app/main.py", "exec"), namespace)
    result = asyncio.run(namespace["discovery_hub_bunkr"](
        query=query, mode=mode, page=page, include_explorer=True, include_external=True))
    assert len(requests) == 1
    params = urllib.parse.parse_qs(urllib.parse.urlparse(requests[0]).query)
    assert params["sort"] == ["latest"]
    assert params["page"] == [str(page)]
    assert params.get("search", [""]) == [query.strip()]
    assert result["mode"] == (mode if query.strip() else "latest")
    assert [item["title"] for item in result["results"]] == ["Newest", "Older"]
    assert result["has_more"] is (page == 1)
    assert result["summary"]["active_total_pages"] == 2
    assert result["summary"]["provider"] == "balbums_html"
