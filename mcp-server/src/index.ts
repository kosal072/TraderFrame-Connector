#!/usr/bin/env node
/**
 * TraderFrame Connector MCP server.
 *
 * Exposes tools that let an agent send trading signals to a configured webhook
 * (e.g. an ATS / TradingView alert endpoint). Position-aware: it only forwards
 * when the side CHANGES for a symbol, so duplicate same-side signals are skipped
 * instead of firing duplicate trades.
 *
 * Configuration (injected as env vars by the MCPB bundle's user_config):
 *   DESTINATION_URL  (required)  Webhook URL to POST signals to.
 *   DRY_RUN          (optional)  "true" -> log/return payload instead of sending.
 *   DEDUPE           (optional)  "false" -> disable position-aware dedupe.
 *   TIMEOUT_MS       (optional)  Outgoing request timeout (default 15000).
 *   STATE_FILE       (optional)  Where to persist per-symbol position memory.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// --------------------------------------------------------------------------- //
// Configuration
// --------------------------------------------------------------------------- //

const DESTINATION_URL = (process.env.DESTINATION_URL || "").trim();
const DEFAULT_SYMBOL = (process.env.DEFAULT_SYMBOL || "").trim();
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");
const DEDUPE = !/^(0|false|no)$/i.test(process.env.DEDUPE ?? "true");
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "15000", 10);
const STATE_FILE =
  (process.env.STATE_FILE || "").trim() ||
  join(homedir(), ".traderframe-connector", "state.json");

// --------------------------------------------------------------------------- //
// Position state (per-symbol last side forwarded)
// --------------------------------------------------------------------------- //

type State = Record<string, string>;

function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return {};
  }
}

function saveState(state: State): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("Could not write state file:", err);
  }
}

// --------------------------------------------------------------------------- //
// Normalization
// --------------------------------------------------------------------------- //

const SIDE_MAP: Record<string, string> = {
  buy: "buy", long: "buy", bullish: "buy",
  sell: "sell", short: "sell", bearish: "sell",
};

function normalizeSide(value: string): string {
  const v = value.trim().toLowerCase();
  return SIDE_MAP[v] ?? v;
}

function normalizeSymbol(value: string): string {
  // Strip trailing sentence punctuation but keep mid-symbol . and / (BRK.B, BTC/USDT).
  return value.trim().replace(/[.,;:!?]+$/, "").toUpperCase();
}

// --------------------------------------------------------------------------- //
// Core forward logic
// --------------------------------------------------------------------------- //

interface ForwardResult {
  status: "forwarded" | "skipped" | "dry_run" | "rejected" | "error";
  side: string;
  symbol: string;
  payload: Record<string, unknown>;
  detail: string;
  destination_status?: number;
  destination_response?: unknown;
}

async function forwardSignal(
  sideRaw: string,
  symbolRaw: string,
  extra?: Record<string, unknown>,
  force = false,
): Promise<ForwardResult> {
  const side = normalizeSide(sideRaw);
  const symbol = normalizeSymbol(symbolRaw);
  const payload: Record<string, unknown> = { side, symbol, ...(extra ?? {}) };

  if (!DESTINATION_URL) {
    return {
      status: "error", side, symbol, payload,
      detail:
        "DESTINATION_URL is not configured. Set it in the connector's settings " +
        "(the webhook URL to POST signals to).",
    };
  }

  // Position-aware dedupe: only act when the side changes for this symbol.
  if (DEDUPE && !force) {
    const state = loadState();
    if (state[symbol] === side) {
      return {
        status: "skipped", side, symbol, payload,
        detail: `No change: ${symbol} is already '${side}'. Nothing sent (use force to override).`,
      };
    }
  }

  if (DRY_RUN) {
    if (DEDUPE) {
      const state = loadState();
      state[symbol] = side;
      saveState(state);
    }
    return {
      status: "dry_run", side, symbol, payload,
      detail: `DRY RUN: would POST to ${DESTINATION_URL}. No real request sent.`,
    };
  }

  // Send it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(DESTINATION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error", side, symbol, payload,
      detail: `Could not reach destination: ${msg}`,
    };
  }
  clearTimeout(timer);

  const text = await resp.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }

  if (resp.ok) {
    if (DEDUPE) {
      const state = loadState();
      state[symbol] = side;
      saveState(state);
    }
    return {
      status: "forwarded", side, symbol, payload,
      detail: `Forwarded ${side} ${symbol} (HTTP ${resp.status}).`,
      destination_status: resp.status,
      destination_response: body,
    };
  }

  return {
    status: "rejected", side, symbol, payload,
    detail: `Destination rejected the signal (HTTP ${resp.status}).`,
    destination_status: resp.status,
    destination_response: body,
  };
}

// --------------------------------------------------------------------------- //
// MCP server + tools
// --------------------------------------------------------------------------- //

const SideEnum = z.enum(["buy", "sell"]);

const SendSignalSchema = z.object({
  side: SideEnum.describe("Trade direction: 'buy' (long) or 'sell' (short/close)."),
  symbol: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(
      "Trading symbol/ticker, e.g. 'SOLUSDT'. OPTIONAL — if omitted, the symbol the " +
      "user configured in the connector's settings is used. Only pass this to override " +
      "that default (e.g. to signal a different symbol).",
    ),
  comment: z
    .string()
    .max(280)
    .optional()
    .describe("Optional note included in the payload (e.g. a short rationale)."),
  force: z
    .boolean()
    .default(false)
    .describe("Bypass position-aware dedupe and send even if the side is unchanged."),
}).strict();

// Build a fresh server instance with all tools registered. A new instance is
// created per HTTP request (stateless), and once for stdio.
function createServer(): McpServer {
  const server = new McpServer({ name: "traderframe-connector-mcp-server", version: "1.0.3" });

server.registerTool(
  "traderframe_send_signal",
  {
    title: "Send Trading Signal",
    description: `Send a buy/sell trading signal for a symbol to the configured webhook (e.g. an ATS/TradingView alert endpoint).

This is the primary tool. It is POSITION-AWARE: by default it only forwards when the side CHANGES for a symbol, so sending 'buy' twice in a row sends just once (the second is skipped). Send the opposite side to flip/close a position.

Args:
  - side ('buy' | 'sell'): trade direction. Required.
  - symbol (string): ticker, e.g. 'SOLUSDT'. OPTIONAL — defaults to the symbol the user
    configured in the connector's settings. Only pass it to override that default. Do NOT
    invent a symbol; if the user hasn't named one, omit it and the configured symbol is used.
  - comment (string): optional short rationale, included in the payload.
  - force (boolean): set true to bypass dedupe and send anyway (default false).

Returns JSON:
  {
    "status": "forwarded" | "skipped" | "dry_run" | "rejected" | "error",
    "side": "buy",
    "symbol": "SOLUSDT",
    "payload": { "side": "buy", "symbol": "SOLUSDT" },
    "detail": "human-readable explanation",
    "destination_status": 200,                // present when a request was made
    "destination_response": { ... }           // the endpoint's response body
  }

Interpretation:
  - "forwarded": sent and accepted (a real action/trade may have executed).
  - "skipped": not sent because the side was unchanged (already in that position).
  - "dry_run": connector is in test mode; nothing was actually sent.
  - "rejected": the endpoint returned a non-2xx; see destination_response for why.
  - "error": misconfiguration or network failure; see detail.

Never claim a trade executed unless status is "forwarded".`,
    inputSchema: SendSignalSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params: z.infer<typeof SendSignalSchema>) => {
    const symbol = (params.symbol ?? DEFAULT_SYMBOL).trim();
    if (!symbol) {
      const result: ForwardResult = {
        status: "error", side: params.side, symbol: "", payload: {},
        detail:
          "No symbol provided and no default symbol is configured. Set a 'Symbol / ticker' " +
          "in the connector's settings, or pass a symbol explicitly.",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
    const extra = params.comment ? { comment: params.comment } : undefined;
    const result = await forwardSignal(params.side, symbol, extra, params.force);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

const GetPositionsSchema = z.object({}).strict();

server.registerTool(
  "traderframe_get_positions",
  {
    title: "Get Tracked Positions",
    description: `Show the connector's record of the last side forwarded per symbol — its view of current open positions.

Returns JSON like { "SOLUSDT": "buy", "ETHUSDT": "sell" }, or {} if nothing is tracked yet. Use this before deciding a signal so you know whether your view is a change (will send) or unchanged (will be skipped).`,
    inputSchema: GetPositionsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const state = loadState();
    return {
      content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
      structuredContent: state as unknown as Record<string, unknown>,
    };
  },
);

const ClearPositionSchema = z.object({
  symbol: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe("Symbol to reset (e.g. 'SOLUSDT'). Omit to clear ALL tracked positions."),
}).strict();

server.registerTool(
  "traderframe_clear_position",
  {
    title: "Clear Tracked Position",
    description: `Reset the connector's position memory so the next signal for a symbol is treated as a fresh change (and will be sent).

Use this when the actual position at the broker no longer matches what the connector remembers. Pass a symbol to clear just that one, or omit to clear everything. This only edits local memory — it does NOT send anything to the endpoint or close any real trade.

Returns the updated state JSON.`,
    inputSchema: ClearPositionSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: z.infer<typeof ClearPositionSchema>) => {
    let state = loadState();
    if (params.symbol) {
      delete state[normalizeSymbol(params.symbol)];
    } else {
      state = {};
    }
    saveState(state);
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, state }, null, 2) }],
      structuredContent: { ok: true, state },
    };
  },
);

  return server;
}

// --------------------------------------------------------------------------- //
// Transports / start
// --------------------------------------------------------------------------- //

const MCP_AUTH_TOKEN = (process.env.MCP_AUTH_TOKEN || "").trim();

function authorized(req: express.Request): boolean {
  if (!MCP_AUTH_TOKEN) return true; // no token configured -> open (not recommended for public)
  const header = (req.headers["authorization"] as string | undefined) || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const fromPath = (req.params?.token as string | undefined) || "";
  const fromQuery = (req.query?.token as string | undefined) || "";
  return [bearer, fromPath, fromQuery].includes(MCP_AUTH_TOKEN);
}

// Local (Claude Desktop .mcpb) — speaks stdio.
async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `traderframe-connector-mcp (stdio) ready (dest=${DESTINATION_URL || "UNSET"}, ` +
    `symbol=${DEFAULT_SYMBOL || "UNSET"}, dry_run=${DRY_RUN}, dedupe=${DEDUPE})`,
  );
}

// Remote (cloud Routines / custom connector) — streamable HTTP with sessions.
async function runHttp(): Promise<void> {
  const app = express();
  app.use(express.json());

  // Active sessions: session id -> transport (each backed by its own server).
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.get("/health", (_req, res) => {
    res.json({ ok: true, destination_configured: Boolean(DESTINATION_URL), dry_run: DRY_RUN });
  });

  const POST = async (req: express.Request, res: express.Response): Promise<void> => {
    if (!authorized(req)) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sid && transports[sid]) {
      transport = transports[sid];
    } else if (!sid && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => { transports[id] = transport; },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      const server = createServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session id (send initialize first)" },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  };

  // GET (server->client stream) and DELETE (end session) reuse an existing session.
  const SESSION = async (req: express.Request, res: express.Response): Promise<void> => {
    if (!authorized(req)) { res.status(401).end(); return; }
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (!sid || !transports[sid]) { res.status(400).send("Invalid or missing session id"); return; }
    await transports[sid].handleRequest(req, res);
  };

  // Token may also be supplied in the path: /mcp/<token>.
  app.post(["/mcp", "/mcp/:token"], POST);
  app.get(["/mcp", "/mcp/:token"], SESSION);
  app.delete(["/mcp", "/mcp/:token"], SESSION);

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.error(
      `traderframe-connector-mcp (http) on :${port}/mcp ` +
      `(auth=${MCP_AUTH_TOKEN ? "token" : "OPEN"}, dest=${DESTINATION_URL || "UNSET"}, ` +
      `symbol=${DEFAULT_SYMBOL || "UNSET"}, dry_run=${DRY_RUN})`,
    );
  });
}

const mode = (process.env.TRANSPORT || (process.env.PORT ? "http" : "stdio")).toLowerCase();
(mode === "http" ? runHttp() : runStdio()).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
