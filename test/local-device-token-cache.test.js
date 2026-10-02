"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { test } = require("node:test");

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-device-cache-http-"));
  const tracker = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(tracker, { recursive: true });
  const saved = Object.fromEntries(["HOME", "USERPROFILE", "TOKENTRACKER_DEVICE_TOKEN", "TOKENTRACKER_INSFORGE_BASE_URL", "TOKENTRACKER_INSFORGE_ANON_KEY"].map((key) => [key, process.env[key]]));
  process.env.HOME = home; process.env.USERPROFILE = home;
  for (const key of Object.keys(saved).filter((key) => key.startsWith("TOKENTRACKER_"))) delete process.env[key];
  let owner = "user-a", mintCount = 0, issueCount = 0, ingestStatus = 200;
  let holdIssue = null, holdRefresh = null, holdAccount = null;
  let strictRefresh = false, validRefreshToken = "user-a-seed";
  const issued = [], ingested = [];
  const backend = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    let payload = {};
    if (req.url.startsWith("/api/auth/refresh")) {
      if (strictRefresh && body.refresh_token !== validRefreshToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Refresh token already consumed" }));
        return;
      }
      mintCount += 1;
      const jwt = `e30.${Buffer.from(JSON.stringify({ sub: owner, exp: Date.now() / 1000 + 3600, nonce: mintCount })).toString("base64url")}.sig`;
      payload = { accessToken: jwt, refreshToken: `${owner}-refresh-${mintCount}`, csrfToken: "fixture-csrf" };
      validRefreshToken = payload.refreshToken;
      if (holdRefresh) await holdRefresh();
    } else if (req.url === "/api/auth/sign-in") {
      owner = body.owner || "user-b";
      payload = { refreshToken: `${owner}-seed`, csrfToken: "fixture-csrf" };
    } else if (req.url === "/functions/tokentracker-device-token-issue") {
      issueCount += 1;
      const sub = JSON.parse(Buffer.from(req.headers.authorization.split(".")[1], "base64url").toString()).sub;
      const token = `fixture-${sub}-${issueCount}`;
      issued.push(token);
      if (holdIssue) await holdIssue(sub);
      payload = { token, device_id: "fixture-device", created_at: new Date().toISOString() };
    } else if (req.url.startsWith("/functions/tokentracker-account-summary")) {
      if (holdAccount) await holdAccount();
      payload = { totals: { total_tokens: 900 } };
    } else if (req.url === "/functions/tokentracker-ingest") {
      ingested.push({ token: req.headers.authorization, body });
      payload = ingestStatus === 200 ? { inserted: body.hourly.length, skipped: 0 } : { error: ingestStatus === 403 ? "Account blocked" : "Unauthorized" };
    }
    res.writeHead(req.url === "/functions/tokentracker-ingest" ? ingestStatus : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = `http://127.0.0.1:${backend.address().port}`;
  await fs.writeFile(path.join(tracker, "config.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${backend.address().port}` }));
  await fs.writeFile(path.join(tracker, "relay-cookies.json"), JSON.stringify({ insforge_refresh_token: "insforge_refresh_token=user-a-seed; Path=/; HttpOnly; SameSite=Lax" }));
  const queue = path.join(tracker, "queue.jsonl");
  const row = { source: "fixture", model: "fixture-model", hour_start: "2026-10-01T00:00:00Z", input_tokens: 40, output_tokens: 0, total_tokens: 40, billable_total_tokens: 40, conversation_count: 1 };
  await fs.writeFile(queue, `${JSON.stringify(row)}\n`);
  const cloudAccount = require("../src/lib/cloud-account");
  cloudAccount.__resetCloudAccountCacheForTests();
  const spawn = childProcess.spawn;
  let spawned = 0;
  childProcess.spawn = (cmd, args, options) => {
    spawned += 1;
    return spawn(cmd, args, { ...options, env: {
      PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot || "", HOME: home, USERPROFILE: home,
      APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), XDG_DATA_HOME: path.join(home, ".local", "share"),
      TOKENTRACKER_AUTO_RETRY_NO_SPAWN: "1", TOKENTRACKER_WSL_MODE: "native-only",
      ...(options.env.TOKENTRACKER_DEVICE_TOKEN ? { TOKENTRACKER_DEVICE_TOKEN: options.env.TOKENTRACKER_DEVICE_TOKEN } : {}),
    } });
  };
  delete require.cache[require.resolve("../src/lib/local-api")];
  const { createLocalApiHandler } = require("../src/lib/local-api");
  const handler = createLocalApiHandler({ queuePath: queue });
  const local = http.createServer((req, res) => { handler(req, res, new URL(req.url, "http://localhost")).catch(() => { res.statusCode = 500; res.end(); }); });
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
  const root = `http://127.0.0.1:${local.address().port}`;
  const auth = (await (await fetch(root + "/api/local-auth")).json()).token;
  const post = async (url, body = {}) => {
    const response = await fetch(root + url, { method: "POST", headers: { "Content-Type": "application/json", "x-tokentracker-local-auth": auth }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const native = (extra = {}) => post("/functions/tokentracker-local-sync", { auto: true, background: true, publishAccount: true, ...extra });
  t.after(async () => {
    childProcess.spawn = spawn; cloudAccount.__resetCloudAccountCacheForTests();
    delete require.cache[require.resolve("../src/lib/local-api")];
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    local.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([new Promise((resolve) => local.close(resolve)), new Promise((resolve) => backend.close(resolve))]);
    await fs.rm(home, { recursive: true, force: true });
  });
  return { post, native, issued, ingested, queue, tracker, row, root,
    setIngestStatus: (status) => { ingestStatus = status; },
    holdIssue: (callback) => { holdIssue = callback; },
    holdRefresh: (callback) => { holdRefresh = callback; },
    holdAccount: (callback) => { holdAccount = callback; },
    enableStrictRefresh: () => { strictRefresh = true; },
    counts: () => ({ mintCount, issueCount, spawned }),
  };
}

test("real local API and CLI reuse an issued token through refresh rotation and isolate a new owner", { timeout: 15_000 }, async (t) => {
  const x = await fixture(t);
  assert.equal((await x.native()).status, 200);
  assert.equal((await x.native()).status, 200);
  assert.equal(x.counts().issueCount, 1);
  assert.equal((await x.post("/api/auth/refresh")).status, 200);
  assert.equal((await x.native()).status, 200);
  assert.equal(x.counts().issueCount, 1, "normal JWT/refresh rotation must not issue another device token");
  assert.equal((await x.post("/api/auth/sign-in", { owner: "user-b" })).status, 200);
  assert.equal((await x.native()).status, 200);
  assert.equal(x.counts().issueCount, 2);
  assert.notEqual(x.issued[0], x.issued[1]);
});

test("native auto drain exposes a fresh 401 and evicts its rejected token, while 403 retains it", { timeout: 15_000 }, async (t) => {
  const x = await fixture(t);
  x.setIngestStatus(401);
  const first = await x.native({ drain: true });
  assert.equal(first.status, 401);
  assert.equal(first.body.code, "CLOUD_DEVICE_TOKEN_REJECTED");
  assert.equal(x.counts().issueCount, 1);
  assert.equal((await x.native()).status, 200);
  assert.equal(x.counts().issueCount, 2, "revoked token is replaced once even while upload backoff is active");
  x.setIngestStatus(403);
  const denied = await x.post("/functions/tokentracker-local-sync", { drain: true });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "CLOUD_UPLOAD_FORBIDDEN");
  assert.equal((await x.native()).status, 200);
  assert.equal(x.counts().issueCount, 2, "policy denial must not churn otherwise valid credentials");
});

test("logout and account switch cancel an in-flight issuance before spawning the old sync", { timeout: 15_000 }, async (t) => {
  const x = await fixture(t);
  let started, release;
  const seen = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  x.holdIssue(async (owner) => { if (owner === "user-a") { started(); await pending; } });
  const old = x.native();
  await seen;
  assert.equal((await x.post("/api/auth/logout")).status, 200);
  assert.equal((await x.post("/api/auth/sign-in", { owner: "user-b" })).status, 200);
  release();
  const cancelled = await old;
  assert.equal(cancelled.status, 409);
  assert.equal(cancelled.body.code, "auth_session_changed");
  assert.equal(x.counts().spawned, 0);
  assert.equal((await x.native()).status, 200);
  assert.equal(x.counts().spawned, 1);
  assert.ok(x.ingested.every((request) => request.token.includes("user-b")));
});

test("cloud sync off retains local background parsing and rejects an explicit foreground upload", { timeout: 15_000 }, async (t) => {
  const x = await fixture(t);
  assert.equal((await x.native()).status, 200);
  const originalIngests = x.ingested.length;
  await fs.appendFile(x.queue, `${JSON.stringify({ ...x.row, total_tokens: 50, input_tokens: 50, billable_total_tokens: 50 })}\n`);
  assert.equal((await x.post("/functions/tokentracker-cloud-sync-pref", { enabled: false })).status, 200);
  const denied = await x.post("/functions/tokentracker-local-sync", { deviceToken: x.issued[0], drain: true });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.code, "CLOUD_SYNC_DISABLED");
  assert.equal((await x.native({ deviceToken: x.issued[0] })).status, 200);
  assert.equal(x.ingested.length, originalIngests);
});

for (const mode of ["proxy", "mobile"]) {
  test(`turning cloud sync off preserves a consumed refresh token through ${mode} HTTP refresh`, { timeout: 15_000 }, async (t) => {
    const x = await fixture(t);
    x.enableStrictRefresh();
    let started, release;
    const seen = new Promise((resolve) => { started = resolve; });
    const pending = new Promise((resolve) => { release = resolve; });
    x.holdRefresh(async () => { started(); await pending; });
    const old = mode === "proxy" ? x.post("/api/auth/refresh") : x.native({ drain: true });
    await seen;
    assert.equal((await x.post("/functions/tokentracker-cloud-sync-pref", { enabled: false })).status, 200);
    release();
    const result = await old;
    assert.equal(result.status, mode === "proxy" ? 200 : 409);
    if (mode === "mobile") assert.equal(result.body.code, "CLOUD_SYNC_CHANGED");
    const persisted = JSON.parse(await fs.readFile(path.join(x.tracker, "relay-cookies.json"), "utf8"));
    assert.ok(persisted.insforge_refresh_token.includes("refresh-1"), "same-account rotation must replace the consumed credential");
    assert.ok(persisted.insforge_csrf_token.includes("fixture-csrf"));
    x.holdRefresh(null);
    assert.equal((await x.post("/api/auth/refresh")).status, 200, "the next authentication refresh still succeeds while cloud sync is off");
    assert.equal(x.counts().issueCount, 0);
    assert.equal(x.counts().spawned, 0);
    assert.equal(x.ingested.length, 0);
  });
}

test("cloud sync off suppresses a late account response after preserving its rotation", { timeout: 15_000 }, async (t) => {
  const x = await fixture(t);
  x.enableStrictRefresh();
  let started, release;
  const seen = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  x.holdAccount(async () => { started(); await pending; });
  const old = fetch(x.root + "/functions/tokentracker-usage-summary?from=2026-10-01&to=2026-10-01&account=1");
  await seen;
  assert.equal((await x.post("/functions/tokentracker-cloud-sync-pref", { enabled: false })).status, 200);
  release();
  const response = await old;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-tokentracker-account-view"), "0");
  assert.equal(response.headers.get("x-tokentracker-account-fallback"), "cloud-sync-off");
  assert.equal((await response.json()).totals.total_tokens, 40);
  assert.equal((await x.post("/api/auth/refresh")).status, 200);
  assert.equal(x.counts().issueCount, 0);
  assert.equal(x.ingested.length, 0);
});
