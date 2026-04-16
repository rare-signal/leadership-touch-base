"""OpenAI-compatible client for David's local LLM cluster.

Single source of truth for the endpoints, model names, retry + fallback logic.
Used by characters.py, personas.py, and anywhere else we need a chat call.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import requests
from rich.console import Console

console = Console()

DEFAULT_ENDPOINTS = (
    "http://192.168.86.243:1234",
    "http://192.168.86.250:1234",
    "http://192.168.86.39:1234",
)


@dataclass
class ClusterConfig:
    endpoints: tuple[str, ...]
    model: str
    fallback_model: str
    api_key: str = ""

    @classmethod
    def from_env(cls) -> "ClusterConfig":
        from dotenv import load_dotenv
        # walk up to the repo root .env
        load_dotenv(Path(__file__).resolve().parents[3] / ".env")
        raw = os.environ.get("LARP_LLM_ENDPOINTS", "")
        eps = tuple(e.strip().rstrip("/") for e in re.split(r"[,\n]", raw) if e.strip()) or DEFAULT_ENDPOINTS
        return cls(
            endpoints=eps,
            model=os.environ.get("LARP_LLM_MODEL", "crow-9b-opus-4.6-distill-heretic_qwen3.5"),
            fallback_model=os.environ.get("LARP_LLM_MODEL_FALLBACK", "qwen/qwen3.5-9b"),
            api_key=os.environ.get("LARP_LLM_API_KEY", ""),
        )


class ClusterClient:
    def __init__(self, cfg: ClusterConfig | None = None):
        self.cfg = cfg or ClusterConfig.from_env()
        self._good_endpoint: str | None = None

    # ---------- low-level ----------
    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.cfg.api_key:
            h["Authorization"] = f"Bearer {self.cfg.api_key}"
        return h

    def _try_endpoints(self) -> Iterable[str]:
        # Prefer last-good, then rest in order
        ordered = (
            [self._good_endpoint, *[e for e in self.cfg.endpoints if e != self._good_endpoint]]
            if self._good_endpoint
            else list(self.cfg.endpoints)
        )
        for e in ordered:
            if e:
                yield e

    def chat(
        self,
        messages: list[dict],
        *,
        max_tokens: int = 1024,
        temperature: float = 0.6,
        json_mode: bool = False,
        timeout: int = 180,
        model: str | None = None,
    ) -> str:
        body: dict = {
            "model": model or self.cfg.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        # LM Studio uses `json_schema` rather than `json_object` and requires an
        # explicit schema; we rely on prompt + regex extraction instead.
        _ = json_mode  # reserved for future servers that support json_object
        last_err: Exception | None = None
        for ep in self._try_endpoints():
            try:
                r = requests.post(
                    f"{ep}/v1/chat/completions",
                    headers=self._headers(),
                    json=body,
                    timeout=timeout,
                )
                if not r.ok:
                    raise RuntimeError(f"{ep} -> HTTP {r.status_code}: {r.text[:200]}")
                data = r.json()
                content = data["choices"][0]["message"]["content"]
                self._good_endpoint = ep
                return content
            except Exception as e:
                last_err = e
                console.print(f"[yellow]cluster miss {ep}: {type(e).__name__}[/yellow]")
                continue
        # Retry once with fallback model before giving up
        if (model or self.cfg.model) != self.cfg.fallback_model:
            console.print(f"[yellow]retrying with fallback model {self.cfg.fallback_model}[/yellow]")
            return self.chat(
                messages,
                max_tokens=max_tokens,
                temperature=temperature,
                json_mode=json_mode,
                timeout=timeout,
                model=self.cfg.fallback_model,
            )
        raise RuntimeError(f"all endpoints failed; last error: {last_err}")

    def chat_json(self, messages: list[dict], **kw) -> dict:
        """Chat + extract JSON from response. Strips markdown fences if present."""
        text = self.chat(messages, json_mode=True, **kw)
        text = text.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(json)?", "", text).strip()
            text = re.sub(r"```$", "", text).strip()
        # Sometimes the model prepends prose — find first {
        if not text.startswith("{"):
            m = re.search(r"\{[\s\S]*\}", text)
            if m:
                text = m.group(0)
        return json.loads(text)
