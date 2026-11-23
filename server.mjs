#!/usr/bin/env node
/**
 * Magpie -> T3 Code usage-limit hub shim.
 *
 * T3 Code's "Add hub" speaks the CLIProxyAPI management protocol:
 *   GET  /v0/management/auth-files
 *   POST /v0/management/api-call      { auth_index, method, url, header, data? }
 * Magpie exposes its subscription quotas at:
 *   GET  /v1/magpie/accounts
 *   GET  /v1/magpie/quotas
 *
 * One source exposes only providers T3 supports natively: Claude and Codex.
 * Other Magpie providers are intentionally left out so their quotas cannot be
 * misrepresented as Antigravity or disrupt T3's provider-grouped UI.
 *
 * Read-only; it never writes to Magpie.
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

const MAGPIE_URL = (process.env.MAGPIE_URL ?? "http://127.0.0.1:3425").replace(/\/+$/, "");
const PORT = Number(process.env.PORT ?? 38765);
const HOST = process.env.HOST ?? "127.0.0.1";
const MANAGEMENT_KEY = process.env.MANAGEMENT_KEY ?? "";
const CACHE_MS = Number(process.env.CACHE_MS ?? 10_000);

if (!MANAGEMENT_KEY) {
  console.error("MANAGEMENT_KEY is required");
  process.exit(1);
}

const MAIN_PROVIDERS = new Set(["claude", "codex"]);
const T3_PROVIDER = {
  claude: "claude",
  codex: "codex"
};

let accountsCache = { at: 0, data: null };
let quotasCache = { at: 0, data: null };

async function getJson(path) {
  const res = await fetch(`${MAGPIE_URL}${path}`, {
    headers: { Authorization: "Bearer local" },
    signal: AbortSignal.timeout(8_000)
  });
  if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}`);
  return res.json();
}

async function getAccounts() {
  const now = Date.now();
  if (accountsCache.data && now - accountsCache.at < CACHE_MS) return accountsCache.data;
  const body = await getJson("/v1/magpie/accounts");
  accountsCache = { at: now, data: body.data ?? [] };
  return accountsCache.data;
}

async function getQuotas() {
  const now = Date.now();
  if (quotasCache.data && now - quotasCache.at < CACHE_MS) return quotasCache.data;
  const body = await getJson("/v1/magpie/quotas");
  quotasCache = { at: now, data: body.data ?? [] };
  return quotasCache.data;
}

function authOk(req) {
  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${MANAGEMENT_KEY}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const clamp = (value) => Math.max(0, Math.min(100, value));

function usedPercent(window) {
  if (typeof window?.used === "number" && Number.isFinite(window.used)) return clamp(window.used);
  if (typeof window?.remaining === "number" && Number.isFinite(window.remaining)) return clamp(100 - window.remaining);
  return null;
}

function resetsAt(window) {
  const value = window?.resetsAt;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function epochSeconds(value) {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function windowOf(quota, pattern) {
  return (quota?.windows ?? []).find((w) => pattern.test(String(w.name ?? ""))) ?? null;
}

function windowDurationSeconds(name) {
  const text = String(name ?? "").toLowerCase();
  if (/30\s*day|month/.test(text)) return 30 * 86_400;
  if (/7\s*day|week/.test(text)) return 7 * 86_400;
  if (/5\s*hour|5\s*h\b/.test(text)) return 5 * 3_600;
  return undefined;
}

function accountLabel(account) {
  return account.label?.trim() || account.user?.trim() || account.id;
}

function accountEmail(account) {
  const value = account.user?.trim() || account.label?.trim() || "";
  return value.includes("@") ? value : undefined;
}

const MAIN_PROVIDER_LABEL = { claude: "Claude", codex: "Codex" };

function mainAccountId(account) {
  return `${MAIN_PROVIDER_LABEL[account.provider]} · ${accountLabel(account)}`;
}

function matchQuota(account, quotas) {
  const list = quotas.filter((q) => q.provider === account.provider);
  if (list.length === 0) return null;
  const labels = [account.user, account.label].filter((value) => typeof value === "string" && value.length > 0);
  const match = list.find((q) => q.user && labels.includes(q.user));
  if (match) return match;
  return list.length === 1 ? list[0] : null;
}

function findAccount(accounts, authIndex) {
  const parts = String(authIndex ?? "").split(":");
  if (parts.length < 3 || parts[0] !== "magpie" || !MAIN_PROVIDERS.has(parts[1])) return null;
  const id = parts.slice(2).join(":");
  return accounts.find((a) => a.provider === parts[1] && a.id === id) ?? null;
}

function claudeUsageFor(quota) {
  const five = windowOf(quota, /5\s*hour|5\s*h\b/i);
  const seven = windowOf(quota, /7\s*day|7\s*d\b|week/i);
  return {
    five_hour: five ? { utilization: usedPercent(five), resets_at: resetsAt(five) } : null,
    seven_day: seven ? { utilization: usedPercent(seven), resets_at: resetsAt(seven) } : null,
    limits: [],
    extra_usage: null
  };
}

function codexUsageFor(quota) {
  const windows = (quota?.windows ?? []).filter(
    (w) =>
      typeof w.used === "number" &&
      Number.isFinite(w.used) &&
      w.unlimited !== true &&
      !/image/i.test(String(w.name ?? ""))
  );
  const toWindow = (window) => {
    const out = { used_percent: clamp(window.used) };
    const reset = epochSeconds(window.resetsAt);
    if (reset !== undefined) out.reset_at = reset;
    const duration = windowDurationSeconds(window.name);
    if (duration !== undefined) out.limit_window_seconds = duration;
    return out;
  };
  const [primary, secondary] = windows;
  return {
    ...(quota?.plan ? { plan_type: String(quota.plan) } : {}),
    rate_limit: {
      primary_window: primary ? toWindow(primary) : null,
      secondary_window: secondary ? toWindow(secondary) : null
    }
  };
}

function authFilesFor(accounts) {
  const seen = new Set();
  return accounts
    .filter((account) => MAIN_PROVIDERS.has(account.provider) && account.on !== false)
    .map((account) => {
      const base = mainAccountId(account);
      let id = base;
      if (seen.has(id)) id = `${base} · ${String(account.id).slice(-4)}`;
      while (seen.has(id)) id = `${id}·`;
      seen.add(id);
      return {
        id,
        auth_index: `magpie:${account.provider}:${account.id}`,
        provider: T3_PROVIDER[account.provider],
        ...(accountEmail(account) ? { email: accountEmail(account) } : {}),
        disabled: false
      };
    });
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;

    if (path === "/health") {
      const [accounts, quotas] = await Promise.all([getAccounts(), getQuotas()]);
      return json(res, 200, {
        ok: true,
        magpie: MAGPIE_URL,
        accounts: accounts.length,
        quotas: quotas.length,
        supportedAccounts: authFilesFor(accounts).length
      });
    }

    if (!path.startsWith("/v0/management/")) {
      return json(res, 404, { error: "not found" });
    }
    if (!authOk(req)) return json(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && path === "/v0/management/auth-files") {
      const accounts = await getAccounts();
      return json(res, 200, { files: authFilesFor(accounts) });
    }

    if (req.method === "POST" && path === "/v0/management/api-call") {
      const raw = await readBody(req);
      let input = {};
      try {
        input = raw ? JSON.parse(raw) : {};
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      const [accounts, quotas] = await Promise.all([getAccounts(), getQuotas()]);
      const account = findAccount(accounts, input.auth_index);
      if (!account) return json(res, 200, { status_code: 404, body: "{}" });
      const quota = matchQuota(account, quotas);
      const callUrl = String(input.url ?? "");

      if (input.auth_index.startsWith("magpie:claude:")) {
        return json(res, 200, {
          status_code: 200,
          body: JSON.stringify(claudeUsageFor(quota))
        });
      }

      if (input.auth_index.startsWith("magpie:codex:")) {
        if (callUrl.includes("rate-limit-reset-credits")) {
          return json(res, 200, { status_code: 404, body: "{}" });
        }
        return json(res, 200, {
          status_code: 200,
          body: JSON.stringify(codexUsageFor(quota))
        });
      }

      return json(res, 200, { status_code: 404, body: "{}" });
    }

    return json(res, 404, { error: "not found" });
  } catch (error) {
    console.error(new Date().toISOString(), error?.stack ?? String(error));
    if (!res.headersSent) json(res, 502, { error: String(error?.message ?? error) });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`magpie-t3-shim listening on http://${HOST}:${PORT} -> ${MAGPIE_URL}`);
});
