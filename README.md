# Claude Routine → Webhook Connector

Receives a **Claude Routine** (scheduled cloud agent) response as an incoming webhook,
extracts the signal from it, maps it to a **custom JSON payload**, and forwards it to a
destination webhook URL (e.g. the ATS trading-view alert endpoint, or any custom endpoint).

```
Claude Routine ──POST──▶ /forward ──transform──▶ POST destination_url
  (raw response)         parse + map to template   (your custom JSON)
```

## Setup

```bash
cd claude-webhook-connector
cp config.example.json config.json   # then edit destination_url + template
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python connector.py        # listens on http://0.0.0.0:8000
```

> `config.json` holds your real endpoint and is gitignored. Commit only `config.example.json`.

Override host/port with env vars: `HOST=127.0.0.1 PORT=9000 .venv/bin/python connector.py`

## Endpoints

| Method | Path           | Purpose                                                        |
|--------|----------------|----------------------------------------------------------------|
| GET    | `/health`      | Liveness + shows whether a destination is configured           |
| POST   | `/forward`     | Receive routine response, transform, forward                   |
| GET    | `/state`       | Show the last side forwarded per symbol (position memory)      |
| POST   | `/state/clear` | Reset position memory (`?symbol=SOLUSDT` for one, or all)      |

Point your Claude Routine at `http://localhost:8000/forward`. Add `?force=1` to `/forward`
to bypass the position-aware dedupe for one request.

## Use it with Claude (Routines / scheduled tasks)

You do **not** need a server or any account — the connector runs on your own machine, and
your Claude scheduled task runs locally too, so it reaches the connector at `localhost`.

1. **Run the connector** (see Setup above). Confirm `curl localhost:8000/health` responds.
2. **Point it at your endpoint:** edit `destination_url` and `template` in `config.json`.
   Keep `"dry_run": true` until you've tested — it logs the payload instead of sending.
3. **Create a Claude scheduled task** (ask Claude to "schedule a task", or use the
   **Scheduled** panel). Paste a prompt like this, edited for your symbol/logic:

   ```
   Analyze <YOUR SYMBOL>, decide a single direction (buy or sell), then run:

   curl -s -X POST http://localhost:8000/forward \
     -H "Content-Type: application/json" \
     -d '{"response": "Side: <buy|sell>, Symbol: <YOUR SYMBOL>"}'

   Phrase the final line exactly as "Side: <buy|sell>, Symbol: <SYMBOL>" so it parses.
   Report whether the response was forwarded (200), skipped (no change), or rejected.
   ```

4. **Test, then go live:** run the task once with `dry_run: true` and check the output /
   `connector.out.log`. When the payload looks right, set `"dry_run": false`.

The connector is **position-aware**: it only forwards when the side *changes* for a symbol,
so repeated same-side signals are skipped instead of firing duplicate actions.

## Configuration (`config.json`)

Re-read on every request — edit and save, no restart needed.

| Key                   | Meaning                                                                 |
|-----------------------|-------------------------------------------------------------------------|
| `destination_url`     | Where the transformed payload is POSTed.                                |
| `mode`                | `template` (map to `template`) or `passthrough` (forward incoming JSON).|
| `template`            | The custom JSON shape, with `{{placeholder}}` values (see below).       |
| `coerce_numbers`      | `true` → numeric/boolean-looking strings become real JSON types.        |
| `incoming_secret`     | If set, callers must send `X-Connector-Secret` header or `?secret=`.    |
| `destination_headers` | Extra headers for the outgoing POST (e.g. `{"Authorization":"Bearer …"}`).|
| `timeout`             | Outgoing request timeout, seconds.                                      |
| `dry_run`             | `true` → don't actually POST; return what *would* be sent. Great for testing. |

### Template placeholders

- `{{symbol}}` — replaced by the extracted `symbol` value.
- `{{quantity|1}}` — `1` is the default if `quantity` is missing.
- A value that is *only* a placeholder (e.g. `"{{price}}"`) keeps its real type → `65000` (number), not `"65000"`.
- Inline placeholders (e.g. `"Signal for {{symbol}}"`) render as strings.
- `{{raw_text}}` — the full text of the model's response, always available.

## How extraction works

The connector finds the signal in this order:

1. **Structured fields** already present at the top level of the incoming JSON.
2. **JSON embedded in the model text** — a ```` ```json ```` block, or the first `{…}` object.
3. **Plain-text key/value** — patterns like `Action: BUY  Symbol: BTCUSDT  Price: 65,000  SL: 64000  TP: 67500`.

It handles these incoming shapes automatically: `{"response": …}`, `{"result": …}`,
`{"output": …}`, `{"text": …}`, `{"content": [{"type":"text","text":…}]}`,
`{"messages":[…]}`, and a raw text body.

## Test it (dry run)

Set `"dry_run": true` in `config.json`, then:

```bash
curl -s localhost:8000/forward -H 'Content-Type: application/json' \
  -d '{"response":"Side: BUY  Symbol: BTCUSDT"}'
# -> forwards {"side":"buy","symbol":"BTCUSDT"}
```

Returns the exact payload that *would* be forwarded. Set `dry_run` back to `false` to go live.

**`side` normalization:** the buy/sell value is taken from `side` *or* `action`/`signal`/`direction`
in the routine output, lowercased, and mapped to canonical `buy`/`sell` (`long→buy`, `short→sell`).

## Production deploy

The Flask dev server is fine for testing; for always-on use run it under **gunicorn**.

**Option A — run directly:**
```bash
.venv/bin/gunicorn -c gunicorn.conf.py wsgi:app
```
Tune with env vars: `WEB_CONCURRENCY` (workers), `THREADS`, `PORT`, `WORKER_TIMEOUT`.

**Option B — managed macOS service (starts at login, auto-restarts on crash):**
```bash
cp com.autobot.connector.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.autobot.connector.plist
# logs -> connector.out.log / connector.err.log ; unload to stop
```

**Option C — Docker:**
```bash
docker build -t autobot-connector .
docker run -p 8000:8000 -v "$PWD/config.json:/app/config.json" autobot-connector
```

> If the routine reaches the connector over the internet, put it behind HTTPS
> (a reverse proxy or tunnel) and set `incoming_secret` so only your routine can trigger it.

## Adapting to a different endpoint

Just change `destination_url` and rewrite `template` to match what that endpoint expects.
For a TradingView-style endpoint that wants whatever JSON you give it, the current template
is a good starting point. If your endpoint needs auth, add it under `destination_headers`.
