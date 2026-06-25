# TraderFrame Connector — MCP Server

Add this connector to **Claude Desktop** and Claude can send buy/sell trading signals
to a webhook you configure (an ATS / TradingView-style alert endpoint, or any URL).

It is **position-aware**: a signal is only forwarded when the side *changes* for a
symbol, so repeated same-side signals are skipped instead of firing duplicate trades.

## Install (one click)

1. Download **`traderframe-connector.mcpb`** (from the repo's
   [latest release](https://github.com/kosal072/TraderFrame-Connector/releases)).
2. **Double-click** it — Claude Desktop opens an install dialog showing the TraderFrame
   logo and the tools it provides.
3. In the dialog, set your **Webhook URL** (e.g.
   `https://api.ats.miraiminds.co/v1/alerts/trading-view/<id>`). Leave **Dry run** on
   while testing; turn it off to go live.
4. Click **Install**. Done — no Python, Node, or terminal required.

## Tools

| Tool | What it does |
|------|--------------|
| `traderframe_send_signal` | Send a `buy`/`sell` signal for a symbol. Position-aware; `force: true` bypasses dedupe. |
| `traderframe_get_positions` | Show the last side sent per symbol (tracked positions). |
| `traderframe_clear_position` | Reset position memory (one symbol or all). Local only — sends nothing. |

Example: *"Send a buy signal for SOLUSDT."* → Claude calls `traderframe_send_signal`
with `{ side: "buy", symbol: "SOLUSDT" }`.

## Settings (configured in the install dialog)

| Setting | Default | Meaning |
|---------|---------|---------|
| Webhook URL | — (required) | Where signals are POSTed as `{"side","symbol"}`. |
| Dry run | on | Don't actually send — for testing. Turn off to go live. |
| Position-aware dedupe | on | Only send when the side changes for a symbol. |

State (tracked positions) is stored at `~/.traderframe-connector/state.json`.

## Build from source

```bash
cd mcp-server
npm install
npm run build                 # compiles src/ -> server/
npm prune --omit=dev
npx @anthropic-ai/mcpb pack . ../traderframe-connector.mcpb
```

The MCP server speaks stdio and can also be added manually to any MCP client:

```json
{
  "mcpServers": {
    "traderframe-connector": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/server/index.js"],
      "env": { "DESTINATION_URL": "https://your-endpoint/...", "DRY_RUN": "true" }
    }
  }
}
```
