"""Minimal HTTP client with retry, exponential backoff and rate limiting.

The collector must work on a bare Python install, so this module deliberately
uses only the standard library. Vendor adapters pass their request headers and
share one client instance; throttling is per client (i.e. per host family).
"""

from __future__ import annotations

import json
import random
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)


class HttpError(RuntimeError):
    """Raised when a request still fails after every retry."""


class HttpClient:
    def __init__(
        self,
        *,
        timeout: float = 15.0,
        retries: int = 4,
        backoff: float = 0.6,
        max_backoff: float = 20.0,
        min_interval: float = 0.35,
        user_agent: str = DEFAULT_USER_AGENT,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.timeout = timeout
        self.retries = max(0, retries)
        self.backoff = backoff
        self.max_backoff = max_backoff
        self.min_interval = min_interval
        self._base_headers = {"User-Agent": user_agent, "Accept": "*/*"}
        if headers:
            self._base_headers.update(headers)
        self._lock = threading.Lock()
        self._last_call = 0.0
        self.requests = 0
        self.retries_done = 0
        self.failures = 0

    def _throttle(self) -> None:
        if self.min_interval <= 0:
            return
        with self._lock:
            wait = self.min_interval - (time.monotonic() - self._last_call)
            if wait > 0:
                time.sleep(wait)
            self._last_call = time.monotonic()

    def get_bytes(self, url: str, params: dict[str, Any] | None = None) -> bytes:
        if params:
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}{urllib.parse.urlencode(params)}"

        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            self._throttle()
            request = urllib.request.Request(url, headers=dict(self._base_headers))
            try:
                self.requests += 1
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return response.read()
            except urllib.error.HTTPError as exc:
                last_error = exc
                if exc.code not in (408, 425, 429, 500, 502, 503, 504):
                    break
            except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as exc:
                last_error = exc

            if attempt >= self.retries:
                break
            self.retries_done += 1
            delay = min(self.max_backoff, self.backoff * (2**attempt))
            time.sleep(delay + random.uniform(0, 0.25))

        self.failures += 1
        raise HttpError(f"GET {url} failed after {self.retries + 1} attempts: {last_error}")

    def get_text(self, url: str, params: dict[str, Any] | None = None) -> str:
        return self.get_bytes(url, params).decode("utf-8", errors="replace")

    def get_json(self, url: str, params: dict[str, Any] | None = None) -> Any:
        text = self.get_text(url, params).strip()
        if not text:
            raise HttpError(f"empty response from {url}")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise HttpError(f"invalid JSON from {url}: {exc}") from exc