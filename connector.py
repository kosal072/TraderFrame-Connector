#!/usr/bin/env python3
"""
Claude Routine -> Webhook Connector
===================================

Receives a Claude Routine (scheduled cloud agent) response as an incoming
webhook, extracts a trading signal from it, maps it to a custom JSON payload
defined in config.json, and forwards it to a destination webhook URL.

Flow:
    Claude Routine --POST--> /forward --transform--> POST destination_url

Run:
    pip install -r requirements.txt
    python connector.py
    # listens on http://0.0.0.0:8000  (override with PORT / HOST env vars)

The destination endpoint can be anything, e.g. the ATS trading-view alert URL:
    https://api.ats.miraiminds.co/v1/alerts/trading-view/<id>
"""

import json
import os
import re
import logging
from pathlib import Path

import requests
from flask import Flask, request, jsonify

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("CONNECTOR_CONFIG", BASE_DIR / "config.json"))

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("connector")


def load_config() -> dict:
    """Load config.json fresh on every request so edits apply without restart."""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        log.error("Config not found at %s", CONFIG_PATH)
        return {}
    except json.JSONDecodeError as exc:
        log.error("config.json is not valid JSON: %s", exc)
        return {}


# --------------------------------------------------------------------------- #
# Extraction:  raw incoming payload  ->  signal dict
# --------------------------------------------------------------------------- #

# Keys that commonly hold the model's text in routine / Anthropic-style payloads.
_TEXT_KEYS = ("response", "result", "output", "text", "content", "message", "completion", "body")


def extract_text(payload) -> str:
    """Pull the main text body out of a variety of incoming webhook shapes."""
    if payload is None:
        return ""
    if isinstance(payload, str):
        return payload
    if isinstance(payload, list):
        # Anthropic content-block style: [{"type":"text","text":"..."}]
        parts = []
        for item in payload:
            if isinstance(item, dict):
                parts.append(item.get("text") or item.get("content") or "")
            else:
                parts.append(str(item))
        return "\n".join(p for p in parts if p)
    if isinstance(payload, dict):
        # messages: [{role, content}] -> last assistant message
        if "messages" in payload and isinstance(payload["messages"], list):
            for msg in reversed(payload["messages"]):
                if isinstance(msg, dict) and msg.get("role") in (None, "assistant"):
                    return extract_text(msg.get("content"))
        for key in _TEXT_KEYS:
            if key in payload and payload[key]:
                return extract_text(payload[key])
    # Fallback: stringify the whole thing.
    return json.dumps(payload)


def find_json_object(text: str):
    """Find a JSON object inside free text (fenced ```json block or first {...})."""
    if not text:
        return None

    # 1) Fenced code block ```json ... ```
    fence = re.search(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", text, re.DOTALL | re.IGNORECASE)
    if fence:
        try:
            return json.loads(fence.group(1))
        except json.JSONDecodeError:
            pass

    # 2) First balanced {...} in the text.
    start = text.find("{")
    while start != -1:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    candidate = text[start : i + 1]
                    try:
                        return json.loads(candidate)
                    except json.JSONDecodeError:
                        break
        start = text.find("{", start + 1)
    return None


# Loose key/value extraction for plain-text signals like:
#   "Action: BUY  Symbol: BTCUSDT  Price: 65000  SL: 64000  TP: 67000"
_FIELD_PATTERNS = {
    "action": r"(?:action|side|signal|direction)\s*[:=]\s*([A-Za-z]+)",
    "symbol": r"(?:symbol|ticker|pair|asset)\s*[:=]\s*([A-Za-z0-9/_\-\.]+)",
    "price": r"(?:price|entry|entry[_ ]price)\s*[:=]\s*([0-9][0-9,\.]*)",
    "stop_loss": r"(?:stop[_ ]?loss|sl)\s*[:=]\s*([0-9][0-9,\.]*)",
    "take_profit": r"(?:take[_ ]?profit|tp|target)\s*[:=]\s*([0-9][0-9,\.]*)",
    "quantity": r"(?:quantity|qty|size|amount)\s*[:=]\s*([0-9][0-9,\.]*)",
}


def extract_fields_from_text(text: str) -> dict:
    found = {}
    for field, pattern in _FIELD_PATTERNS.items():
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            # Strip trailing sentence punctuation (e.g. "BTCUSDT." -> "BTCUSDT")
            # while keeping mid-symbol dots/slashes like BRK.B or BTC/USDT.
            found[field] = m.group(1).strip().rstrip(".,;:!?").replace(",", "")
    return found


def build_context(raw_payload) -> dict:
    """Turn the incoming payload into a flat dict of values usable in the template."""
    text = extract_text(raw_payload)

    context = {}
    # If the whole incoming payload is already a structured signal, start from it.
    if isinstance(raw_payload, dict):
        context.update({k: v for k, v in raw_payload.items() if not isinstance(v, (dict, list))})

    # JSON embedded in the text wins over loose regex extraction.
    embedded = find_json_object(text)
    if isinstance(embedded, dict):
        context.update(embedded)
    else:
        context.update(extract_fields_from_text(text))

    # Normalize the buy/sell value into `side` (lowercase), aliasing `action`.
    raw_side = context.get("side") or context.get("action")
    side = normalize_side(raw_side)
    if side:
        context["side"] = side
        context.setdefault("action", side)

    # Always expose the raw text for templates that want to pass it through.
    context.setdefault("raw_text", text.strip())
    return context


# Map common phrasings of direction to canonical lowercase buy/sell.
_SIDE_MAP = {
    "buy": "buy", "long": "buy", "bullish": "buy", "enter long": "buy",
    "sell": "sell", "short": "sell", "bearish": "sell", "enter short": "sell",
}


def normalize_side(value):
    if not value:
        return None
    v = str(value).strip().lower()
    return _SIDE_MAP.get(v, v)


# --------------------------------------------------------------------------- #
# Template rendering:  signal dict + template  ->  outgoing JSON
# --------------------------------------------------------------------------- #

_PLACEHOLDER = re.compile(r"\{\{\s*([^}|]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}")


def _coerce(value: str):
    """Turn numeric / boolean-looking strings into real JSON types."""
    if not isinstance(value, str):
        return value
    v = value.strip()
    if v.lower() in ("true", "false"):
        return v.lower() == "true"
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    if re.fullmatch(r"-?\d*\.\d+", v):
        return float(v)
    return value


def render(node, context: dict, coerce: bool):
    """Recursively substitute {{key}} / {{key|default}} placeholders in the template."""
    if isinstance(node, dict):
        return {k: render(v, context, coerce) for k, v in node.items()}
    if isinstance(node, list):
        return [render(v, context, coerce) for v in node]
    if isinstance(node, str):
        # Whole-value placeholder -> preserve real types (e.g. {{price}} -> number).
        whole = _PLACEHOLDER.fullmatch(node.strip())
        if whole:
            key, default = whole.group(1).strip(), whole.group(2)
            val = context.get(key, default if default is not None else "")
            return _coerce(val) if coerce else val

        # Inline placeholder(s) within a larger string -> string substitution.
        def _sub(m):
            key, default = m.group(1).strip(), m.group(2)
            val = context.get(key, default if default is not None else "")
            return str(val)

        return _PLACEHOLDER.sub(_sub, node)
    return node


# --------------------------------------------------------------------------- #
# Flask app
# --------------------------------------------------------------------------- #

app = Flask(__name__)


@app.get("/health")
def health():
    cfg = load_config()
    return jsonify(
        ok=True,
        destination_configured=bool(cfg.get("destination_url")),
        mode=cfg.get("mode", "template"),
    )


@app.post("/forward")
def forward():
    cfg = load_config()

    # --- optional shared-secret auth on the incoming request ---------------- #
    secret = cfg.get("incoming_secret")
    if secret:
        provided = (
            request.headers.get("X-Connector-Secret")
            or request.args.get("secret")
        )
        if provided != secret:
            return jsonify(error="unauthorized"), 401

    destination_url = cfg.get("destination_url")
    if not destination_url:
        return jsonify(error="destination_url not set in config.json"), 500

    # --- parse incoming body ------------------------------------------------ #
    raw = request.get_json(silent=True)
    if raw is None:
        raw = request.get_data(as_text=True)  # plain-text body

    context = build_context(raw)
    log.info("Extracted context: %s", json.dumps(context)[:500])

    # --- build outgoing payload --------------------------------------------- #
    mode = cfg.get("mode", "template")
    if mode == "passthrough":
        outgoing = raw if isinstance(raw, (dict, list)) else context
    else:
        template = cfg.get("template")
        if not template:
            return jsonify(error="template not set in config.json (mode=template)"), 500
        outgoing = render(template, context, cfg.get("coerce_numbers", True))

    # --- forward ------------------------------------------------------------ #
    headers = {"Content-Type": "application/json"}
    headers.update(cfg.get("destination_headers", {}))

    if cfg.get("dry_run"):
        log.info("DRY RUN -> would POST to %s : %s", destination_url, outgoing)
        return jsonify(dry_run=True, destination=destination_url, payload=outgoing)

    try:
        resp = requests.post(
            destination_url,
            json=outgoing,
            headers=headers,
            timeout=cfg.get("timeout", 15),
        )
    except requests.RequestException as exc:
        log.error("Forward failed: %s", exc)
        return jsonify(error="forward_failed", detail=str(exc), payload=outgoing), 502

    body = resp.text
    try:
        body = resp.json()
    except ValueError:
        pass

    if resp.ok:
        log.info("Forwarded -> %s (%s): %s", destination_url, resp.status_code, body)
    else:
        # Surface the destination's explanation so 4xx/5xx aren't a mystery.
        log.warning(
            "Forward rejected -> %s (%s): %s | sent: %s",
            destination_url, resp.status_code, body, json.dumps(outgoing),
        )

    return jsonify(
        ok=resp.ok,
        forwarded_payload=outgoing,
        destination_status=resp.status_code,
        destination_response=body,
    ), (200 if resp.ok else 502)


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    log.info("Connector listening on http://%s:%d  (config: %s)", host, port, CONFIG_PATH)
    app.run(host=host, port=port)
