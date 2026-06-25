# Remote MCP server (for cloud Routines)

A **cloud Routine** runs in Anthropic's cloud and can only use **remote** connectors —
it cannot reach a local `.mcpb` extension on your Mac. To make TraderFrame Connector
appear under a Routine's **Add connector**, host this server publicly and register its URL.

The same `src/index.ts` runs in two modes:
- **stdio** (default) — for the local `.mcpb` desktop extension.
- **http** — when `TRANSPORT=http` (or `PORT` is set) — a streamable-HTTP MCP server
  with session management, for remote use.

## Deploy to Render (free)

1. Push this repo to GitHub (already done for the official repo).
2. Render Dashboard → **New → Blueprint** → select the repo. It reads `render.yaml`.
3. Set the secret env var **`DESTINATION_URL`** to your webhook (e.g.
   `https://api.ats.miraiminds.co/v1/alerts/trading-view/<id>`). Optionally set
   `DEFAULT_SYMBOL` (defaults to `SOLUSDT`) and flip `DRY_RUN` to `false` when ready.
4. **Apply** → Render builds and gives you a URL like
   `https://traderframe-connector-mcp.onrender.com`.
5. Open the service → **Environment** → copy the generated **`MCP_AUTH_TOKEN`**.

Health check: `GET https://<your-service>.onrender.com/health` → `{"ok":true,...}`.

## Add it to a Routine

In the Routine's **Connectors → Add connector → Custom / by URL**, use the MCP endpoint:

- With the token in the path (simplest):
  `https://<your-service>.onrender.com/mcp/<MCP_AUTH_TOKEN>`
- Or the base URL `https://<your-service>.onrender.com/mcp` with an
  `Authorization: Bearer <MCP_AUTH_TOKEN>` header if the UI supports custom headers.

Once added, TraderFrame Connector lists next to Gmail/Slack, and the Routine can call
`traderframe_send_signal` during cloud runs.

## Auth & env reference

| Env var | Purpose |
|---------|---------|
| `TRANSPORT` | `http` for remote, `stdio` for local (default). |
| `DESTINATION_URL` | Webhook the signals are POSTed to. **Required.** |
| `DEFAULT_SYMBOL` | Symbol used when a request doesn't name one. |
| `MCP_AUTH_TOKEN` | Bearer/path token required to call `/mcp`. **Set this for any public deploy.** |
| `DRY_RUN` | `true` = don't actually send (test). |
| `DEDUPE` | `true` = only send when the side changes per symbol. |
| `STATE_FILE` | Where position memory is stored. |

> **Free-tier note:** Render free web services sleep after ~15 min idle and cold-start
> (~30–60s) on the next request. For scheduled signals that's usually fine; upgrade to a
> paid instance if you need instant response. State in `/tmp` resets on redeploy/restart.

## Run the HTTP server locally

```bash
TRANSPORT=http PORT=8080 \
  DESTINATION_URL="https://your-endpoint/..." DEFAULT_SYMBOL=SOLUSDT \
  DRY_RUN=true MCP_AUTH_TOKEN="choose-a-secret" \
  node server/index.js
# -> http://localhost:8080/mcp  (health at /health)
```
