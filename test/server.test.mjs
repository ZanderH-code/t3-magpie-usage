import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const accounts = [
  { id: "claude-1", provider: "claude", label: "Claude account", user: "claude@example.invalid", plan: "Pro", on: true },
  { id: "codex-1", provider: "codex", label: "Codex account", user: "codex@example.invalid", plan: "free", on: true },
  { id: "copilot-1", provider: "copilot", label: "Copilot Education", plan: "Education", on: true },
  { id: "zed-1", provider: "zed", label: "Zed Student", plan: "Student", on: true },
];
const quotas = [
  { provider: "claude", user: "claude@example.invalid", plan: "Pro", windows: [
    { name: "5 hours", used: 20, remaining: 80, resetsAt: "2030-01-01T00:00:00Z" },
    { name: "7 days", used: 40, remaining: 60, resetsAt: "2030-01-02T00:00:00Z" },
  ] },
  { provider: "codex", user: "codex@example.invalid", plan: "free", windows: [
    { name: "30 days", used: 12, remaining: 88, resetsAt: "2030-02-01T00:00:00Z" },
    { name: "Image generation", used: 0, remaining: 100, display: "Unknown" },
  ] },
  { provider: "copilot", plan: "Education", windows: [
    { name: "Premium requests", used: 25, remaining: 75, display: "50 / 200", resetsAt: "2030-03-01T00:00:00Z" },
    { name: "Chat requests", used: 0, remaining: 100, unlimited: true, display: "Unlimited" },
  ] },
  { provider: "zed", plan: "Student", windows: [] },
];

let magpie;
let bridge;
let bridgeKey;
let bridgePort;
let bridgeOutput = "";

before(async () => {
  magpie = createServer((req, res) => {
    const body = req.url === "/v1/magpie/accounts" ? accounts : req.url === "/v1/magpie/quotas" ? quotas : null;
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: body }));
  });
  magpie.listen(0, "127.0.0.1");
  await once(magpie, "listening");
  const magpiePort = magpie.address().port;

  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  bridgePort = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  bridgeKey = "unit-test-local-key";
  bridge = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    env: { ...process.env, MAGPIE_URL: `http://127.0.0.1:${magpiePort}`, PORT: String(bridgePort), MANAGEMENT_KEY: bridgeKey },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout.setEncoding("utf8").on("data", (chunk) => { bridgeOutput += chunk; });
  bridge.stderr.setEncoding("utf8").on("data", (chunk) => { bridgeOutput += chunk; });
  const readyUrl = `http://127.0.0.1:${bridgePort}/health`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (bridge.exitCode !== null) throw new Error(`bridge exited early: ${bridgeOutput}`);
    try {
      const response = await fetch(readyUrl);
      if (response.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`bridge did not become ready: ${bridgeOutput}`);
});

after(async () => {
  if (bridge && bridge.exitCode === null) bridge.kill("SIGTERM");
  if (bridge) await Promise.race([once(bridge, "exit"), delay(2_000)]);
  if (magpie?.listening) await new Promise((resolve) => magpie.close(resolve));
});

async function management(path, payload) {
  const response = await fetch(`http://127.0.0.1:${bridgePort}${path}`, {
    method: payload ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${bridgeKey}`,
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  return response.json();
}

test("health exposes provider counts without credentials", async () => {
  const response = await fetch(`http://127.0.0.1:${bridgePort}/health`);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.supportedAccounts, 2);
  assert.equal(JSON.stringify(health).includes(bridgeKey), false);
});

test("management auth-files returns only native Claude and Codex drivers", async () => {
  const result = await management("/v0/management/auth-files");
  assert.deepEqual(result.files.map((file) => file.provider), ["claude", "codex"]);
  assert.equal(result.files.some((file) => /Copilot|Zed/.test(file.id)), false);
});

test("API-call translates Claude and Codex quota shapes", async () => {
  const { files } = await management("/v0/management/auth-files");
  const claude = await management("/v0/management/api-call", {
    auth_index: files[0].auth_index,
    method: "GET",
    url: "https://api.anthropic.com/api/oauth/usage",
  });
  const codex = await management("/v0/management/api-call", {
    auth_index: files[1].auth_index,
    method: "GET",
    url: "https://chatgpt.com/backend-api/wham/usage",
  });
  assert.equal(claude.status_code, 200);
  assert.equal(JSON.parse(claude.body).five_hour.utilization, 20);
  assert.equal(codex.status_code, 200);
  assert.equal(JSON.parse(codex.body).rate_limit.primary_window.limit_window_seconds, 30 * 86400);
  const unsupported = await management("/v0/management/api-call", {
    auth_index: "magpie:generic:copilot:copilot-1",
    method: "GET",
    url: "https://example.invalid/usage",
  });
  assert.equal(unsupported.status_code, 404);
});

test("management endpoints reject a missing bearer key", async () => {
  const response = await fetch(`http://127.0.0.1:${bridgePort}/v0/management/auth-files`);
  assert.equal(response.status, 401);
});
