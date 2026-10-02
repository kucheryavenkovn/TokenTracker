"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");

// The handler reads/writes ~/.tokentracker/tracker/. Redirect HOME to a temp
// dir so these tests never touch the developer's real relay cookies or pref.
let tmpHome;
let prevHome;
let prevUserProfile;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-account-view-home-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete require.cache[require.resolve("../src/lib/cloud-account")];
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function freshHandler(queuePath) {
  // Re-require so module-level state (token cache) and the trackerDataDir
  // resolved at construction reflect the temp HOME.
  delete require.cache[require.resolve("../src/lib/local-api")];
  const { createLocalApiHandler } = require("../src/lib/local-api");
  return createLocalApiHandler({ queuePath });
}

function makeReq({ method = "GET", urlObj, headers = {}, body } = {}) {
  const base = Readable.from(body != null ? [Buffer.from(body)] : []);
  base.method = method;
  base.url = urlObj.pathname + urlObj.search;
  base.headers = { host: "localhost", ...headers };
  return base;
}

function makeRes() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 200,
    _headers: headers,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    writeHead(status, hdrs) {
      this.statusCode = status;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
    },
    end(body) {
      if (body) chunks.push(body);
    },
    body() {
      return chunks.join("");
    },
    json() {
      return JSON.parse(chunks.join(""));
    },
  };
}

async function call(handler, opts) {
  const urlObj = new URL(`http://localhost${opts.endpoint}`);
  const req = makeReq({ ...opts, urlObj });
  const res = makeRes();
  const handled = await handler(req, res, urlObj);
  assert.ok(handled, `endpoint must be handled: ${opts.endpoint}`);
  return res;
}

function writeQueue(queuePath, rows) {
  fs.writeFileSync(queuePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const SAMPLE_ROW = {
  source: "claude",
  model: "claude-sonnet-4-6",
  hour_start: "2026-04-20T10:00:00.000Z",
  input_tokens: 100,
  cached_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 20,
  reasoning_output_tokens: 0,
  total_tokens: 120,
  conversation_count: 1,
};

test("cloud-sync-pref defaults to enabled; account stays unavailable while signed out", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const handler = freshHandler(queuePath);
  const res = await call(handler, { endpoint: "/functions/tokentracker-cloud-sync-pref" });
  assert.deepEqual(res.json(), { enabled: true, account_available: false });
});

test("user-status exposes account aggregation state", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const handler = freshHandler(queuePath);
  const res = await call(handler, { endpoint: "/functions/tokentracker-user-status" });
  const body = res.json();
  assert.deepEqual(body.account, {
    available: false,
    // Pref defaults ON, but the account view still requires a signed-in
    // session (relayed refresh token) — absent here, so no cross-device view.
    cloud_sync_enabled: true,
    account_view: false,
  });
});

test("POST cloud-sync-pref requires local auth, then persists and is reflected", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const handler = freshHandler(queuePath);

  // Without the local-auth token the mutation is rejected.
  const denied = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-cloud-sync-pref",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(denied.statusCode, 401);

  // Fetch the token the dashboard would use.
  const authRes = await call(handler, { endpoint: "/api/local-auth" });
  const { token } = authRes.json();
  assert.ok(token);

  const ok = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-cloud-sync-pref",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
    body: JSON.stringify({ enabled: true }),
  });
  assert.deepEqual(ok.json(), { ok: true, enabled: true });

  // Persisted to disk and reflected by a subsequent GET (new handler instance).
  const prefFile = path.join(tmpHome, ".tokentracker", "tracker", "cloud-sync-pref.json");
  assert.equal(JSON.parse(fs.readFileSync(prefFile, "utf8")).enabled, true);

  const handler2 = freshHandler(queuePath);
  const get2 = await call(handler2, { endpoint: "/functions/tokentracker-cloud-sync-pref" });
  assert.equal(get2.json().enabled, true);

  // A non-boolean payload is rejected (400) and must NOT overwrite the pref.
  const token2 = (await call(handler2, { endpoint: "/api/local-auth" })).json().token;
  const bad = await call(handler2, {
    method: "POST",
    endpoint: "/functions/tokentracker-cloud-sync-pref",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token2 },
    body: JSON.stringify({ enabled: "yes" }),
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(JSON.parse(fs.readFileSync(prefFile, "utf8")).enabled, true, "pref must be unchanged");
});

test("usage-summary?account=1 falls back to local data when not signed in", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  // Enable the pref but provide no relay refresh token → not signed in.
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));

  const handler = freshHandler(queuePath);
  const res = await call(handler, {
    endpoint: "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&tz=UTC&account=1",
  });
  // Local (single-machine) data served, tagged as not-account-view.
  assert.equal(res._headers["x-tokentracker-account-view"], "0");
  const body = res.json();
  assert.equal(body.scope, "all");
  assert.equal(body.totals.total_tokens, 120);
});

test("account-view failures are briefly backed off so refresh fan-out stays responsive", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-failing; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  const realFetch = global.fetch;
  let refreshCalls = 0;
  global.fetch = async () => {
    refreshCalls += 1;
    throw new Error("offline");
  };
  try {
    const handler = freshHandler(queuePath);
    const endpoint = "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&account=1";
    const first = await call(handler, { endpoint });
    const second = await call(handler, { endpoint });
    assert.equal(first._headers["x-tokentracker-account-view"], "0");
    assert.equal(second._headers["x-tokentracker-account-view"], "0");
    assert.equal(refreshCalls, 1, "the second refresh should use the failure backoff");
    assert.equal(second.json().totals.total_tokens, 120);
  } finally {
    global.fetch = realFetch;
  }
});

test("concurrent account-view fan-out shares one pending cloud probe", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-concurrent; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  const realFetch = global.fetch;
  let refreshCalls = 0;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  global.fetch = async () => {
    refreshCalls += 1;
    started();
    await gate;
    throw new Error("offline");
  };

  try {
    const handler = freshHandler(queuePath);
    const endpoint = "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&account=1";
    const firstPromise = call(handler, { endpoint });
    await startedPromise;
    // The second request arrives while the first refresh-token probe is still
    // pending. It must immediately use the local fallback rather than opening
    // another timeout-bound network request.
    const second = await call(handler, { endpoint });
    assert.equal(refreshCalls, 1);
    assert.equal(second._headers["x-tokentracker-account-view"], "0");
    assert.equal(second.json().totals.total_tokens, 120);

    release();
    const first = await firstPromise;
    assert.equal(first._headers["x-tokentracker-account-view"], "0");
    assert.equal(first.json().totals.total_tokens, 120);
  } finally {
    global.fetch = realFetch;
  }
});

test("usage-summary?account=1 serves the cross-device aggregate when signed in + cloud sync on", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);

  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  // Seed a relayed refresh token (what the auth proxy would have captured).
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  // Mock the network: token refresh, then the account-summary aggregate.
  const accessJwt = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url")}.sig`;
  const accountPayload = {
    from: "2026-04-20",
    to: "2026-04-20",
    scope: "all",
    totals: { total_tokens: 999999, total_cost_usd: "1.50" },
  };
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (urlStr, opts) => {
    seen.push(String(urlStr));
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/tokentracker-account-summary")) {
      assert.equal(opts.headers.Authorization, `Bearer ${accessJwt}`);
      return { ok: true, status: 200, json: async () => accountPayload };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, {
      endpoint: "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&tz=UTC&account=1",
    });
    assert.equal(res._headers["x-tokentracker-account-view"], "1");
    assert.deepEqual(res.json(), accountPayload);
    assert.ok(seen.some((u) => u.includes("/api/auth/refresh")));
    assert.ok(seen.some((u) => u.includes("/tokentracker-account-summary")));
  } finally {
    global.fetch = realFetch;
  }
});

test("usage-hourly?account=1 serves account hourly data when signed in + cloud sync on", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);

  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  const accessJwt = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url")}.sig`;
  const accountPayload = {
    day: "2026-04-20",
    data: [
      {
        hour: "2026-04-20T10:00:00",
        total_tokens: 999999,
        conversation_count: 3,
        models: { "claude-sonnet-4-6": 999999 },
      },
    ],
  };
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (urlStr, opts) => {
    seen.push(String(urlStr));
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/tokentracker-account-hourly")) {
      assert.equal(opts.headers.Authorization, `Bearer ${accessJwt}`);
      return { ok: true, status: 200, json: async () => accountPayload };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, {
      endpoint: "/functions/tokentracker-usage-hourly?day=2026-04-20&tz=UTC&account=1",
    });
    assert.equal(res._headers["x-tokentracker-account-view"], "1");
    assert.deepEqual(res.json(), accountPayload);
    assert.ok(seen.some((u) => u.includes("/tokentracker-account-hourly")));
  } finally {
    global.fetch = realFetch;
  }
});

test("usage-hourly?account=1 falls back to local hourly data when account hourly fails", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);

  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  const accessJwt = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url")}.sig`;
  const realFetch = global.fetch;
  global.fetch = async (urlStr) => {
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/tokentracker-account-hourly")) {
      return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, {
      endpoint: "/functions/tokentracker-usage-hourly?day=2026-04-20&tz=UTC&account=1",
    });
    assert.equal(res._headers["x-tokentracker-account-view"], "0");
    const body = res.json();
    assert.equal(body.day, "2026-04-20");
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].hour, "2026-04-20T10:00:00");
    assert.equal(body.data[0].total_tokens, 120);
  } finally {
    global.fetch = realFetch;
  }
});

test("usage-hourly?account=1 falls back to local hourly data when account hourly times out", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);

  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  const accessJwt = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url")}.sig`;

  const prevTimeout = process.env.TOKENTRACKER_HTTP_TIMEOUT_MS;
  process.env.TOKENTRACKER_HTTP_TIMEOUT_MS = "10"; // 超低超时：10ms

  const realFetch = global.fetch;
  global.fetch = async (urlStr, opts) => {
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/tokentracker-account-hourly")) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          resolve({ ok: true, status: 200, json: async () => ({ day: "2026-04-20", data: [] }) });
        }, 10000);
        if (opts && opts.signal) {
          opts.signal.addEventListener("abort", () => {
            clearTimeout(t);
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, {
      endpoint: "/functions/tokentracker-usage-hourly?day=2026-04-20&tz=UTC&account=1",
    });
    assert.equal(res._headers["x-tokentracker-account-view"], "0");
    const body = res.json();
    assert.equal(body.day, "2026-04-20");
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].hour, "2026-04-20T10:00:00");
    assert.equal(body.data[0].total_tokens, 120);
  } finally {
    global.fetch = realFetch;
    if (prevTimeout === undefined) {
      delete process.env.TOKENTRACKER_HTTP_TIMEOUT_MS;
    } else {
      process.env.TOKENTRACKER_HTTP_TIMEOUT_MS = prevTimeout;
    }
  }
});

// --- Fallback classification -------------------------------------------------
//
// The popover keeps its last account (cross-device) snapshot when a cloud read
// fails transiently, but must switch to this-machine data when the user signs
// out or turns cloud sync off. That is only possible if the local server says
// WHICH of the two happened.

function seedSignedInTracker() {
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );
  return trackerDir;
}

function freshAccessJwt() {
  return `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url")}.sig`;
}

const HEATMAP_ENDPOINT = "/functions/tokentracker-usage-heatmap?weeks=52&tz=UTC&account=1";

test("account fallback is tagged 'signed-out' when there is no relayed session", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));

  const handler = freshHandler(queuePath);
  const res = await call(handler, { endpoint: HEATMAP_ENDPOINT });
  assert.equal(res._headers["x-tokentracker-account-view"], "0");
  assert.equal(res._headers["x-tokentracker-account-fallback"], "signed-out");
});

test("account fallback is tagged 'cloud-sync-off' when the pref is disabled", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = seedSignedInTracker();
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: false }));

  const handler = freshHandler(queuePath);
  const res = await call(handler, { endpoint: HEATMAP_ENDPOINT });
  assert.equal(res._headers["x-tokentracker-account-view"], "0");
  assert.equal(res._headers["x-tokentracker-account-fallback"], "cloud-sync-off");
});

test("a failing account read is tagged transient, not as a local view", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  seedSignedInTracker();

  const accessJwt = freshAccessJwt();
  const realFetch = global.fetch;
  global.fetch = async (urlStr) => {
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/tokentracker-account-heatmap")) {
      return { ok: false, status: 502, json: async () => ({ error: "bad gateway" }) };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };
  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, { endpoint: HEATMAP_ENDPOINT });
    assert.equal(res._headers["x-tokentracker-account-view"], "0");
    assert.equal(res._headers["x-tokentracker-account-fallback"], "transient-upstream");
  } finally {
    global.fetch = realFetch;
  }
});

test("an account read that times out is tagged transient-timeout", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  seedSignedInTracker();

  const accessJwt = freshAccessJwt();
  const prevTimeout = process.env.TOKENTRACKER_HTTP_TIMEOUT_MS;
  process.env.TOKENTRACKER_HTTP_TIMEOUT_MS = "10";

  const realFetch = global.fetch;
  global.fetch = async (urlStr, opts) => {
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/tokentracker-account-heatmap")) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({}) }), 10000);
        opts?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };
  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, { endpoint: HEATMAP_ENDPOINT });
    assert.equal(res._headers["x-tokentracker-account-view"], "0");
    assert.equal(res._headers["x-tokentracker-account-fallback"], "transient-timeout");
  } finally {
    global.fetch = realFetch;
    if (prevTimeout === undefined) delete process.env.TOKENTRACKER_HTTP_TIMEOUT_MS;
    else process.env.TOKENTRACKER_HTTP_TIMEOUT_MS = prevTimeout;
  }
});

test("a rejected token refresh is tagged transient-auth, not signed-out", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  seedSignedInTracker();

  const realFetch = global.fetch;
  global.fetch = async (urlStr) => {
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: false, status: 401, json: async () => ({ error: "token consumed" }) };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };
  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, { endpoint: HEATMAP_ENDPOINT });
    assert.equal(res._headers["x-tokentracker-account-view"], "0");
    assert.equal(
      res._headers["x-tokentracker-account-fallback"],
      "transient-auth",
      "A rejected refresh must never look like the user signing out.",
    );
  } finally {
    global.fetch = realFetch;
  }
});

test("an offline account read is tagged transient-network", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  seedSignedInTracker();

  const realFetch = global.fetch;
  global.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, { endpoint: HEATMAP_ENDPOINT });
    assert.equal(res._headers["x-tokentracker-account-view"], "0");
    assert.equal(res._headers["x-tokentracker-account-fallback"], "transient-network");
  } finally {
    global.fetch = realFetch;
  }
});

test("a successful account read carries no fallback header", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  seedSignedInTracker();

  const accessJwt = freshAccessJwt();
  const payload = { weeks: [], active_days: 3 };
  const realFetch = global.fetch;
  global.fetch = async (urlStr) => {
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/tokentracker-account-heatmap")) {
      return { ok: true, status: 200, json: async () => payload };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };
  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, { endpoint: HEATMAP_ENDPOINT });
    assert.equal(res._headers["x-tokentracker-account-view"], "1");
    assert.equal(res._headers["x-tokentracker-account-fallback"], undefined);
    assert.deepEqual(res.json(), payload);
  } finally {
    global.fetch = realFetch;
  }
});

test("one popover refresh mints ONE access token across concurrent account reads", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  seedSignedInTracker();

  const accessJwt = freshAccessJwt();
  let refreshCalls = 0;
  const realFetch = global.fetch;
  global.fetch = async (urlStr) => {
    const u = String(urlStr);
    if (u.includes("/api/auth/refresh")) {
      refreshCalls += 1;
      // Rotate on every call: a second refresh with the same (already consumed)
      // token is exactly what used to fail intermittently.
      if (refreshCalls > 1) return { ok: false, status: 401, json: async () => ({ error: "consumed" }) };
      await new Promise((r) => setTimeout(r, 5));
      return {
        ok: true,
        status: 200,
        json: async () => ({ accessToken: accessJwt, refreshToken: "rotated-1" }),
      };
    }
    if (u.includes("/tokentracker-account-")) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };
  try {
    const handler = freshHandler(queuePath);
    const endpoints = [
      HEATMAP_ENDPOINT,
      "/functions/tokentracker-usage-daily?from=2026-04-20&to=2026-04-20&tz=UTC&account=1",
      "/functions/tokentracker-usage-monthly?from=2026-04-01&to=2026-04-30&tz=UTC&account=1",
      "/functions/tokentracker-usage-model-breakdown?from=2026-04-20&to=2026-04-20&tz=UTC&account=1",
    ];
    const results = await Promise.all(endpoints.map((endpoint) => call(handler, { endpoint })));
    assert.equal(refreshCalls, 1, "concurrent account reads must share one token refresh");
    for (const res of results) {
      assert.equal(res._headers["x-tokentracker-account-view"], "1");
    }
  } finally {
    global.fetch = realFetch;
  }
});

test("loopback account reads invalidate on successful-upload state, reset, and explicit refresh", async (t) => {
  const http = require("node:http");
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "relay-cookies.json"), JSON.stringify({
    insforge_refresh_token: "insforge_refresh_token=upload-test; Path=/; HttpOnly; SameSite=Lax",
  }));
  const statePath = path.join(tmpHome, "queue.state.json");
  fs.writeFileSync(statePath, JSON.stringify({ offset: 100, updatedAt: "first" }));
  const handler = freshHandler(queuePath);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    handler(req, res, url).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const realFetch = global.fetch;
  let edgeCalls = 0;
  const token = `e30.${Buffer.from(JSON.stringify({ sub: "upload-user", exp: Date.now() / 1000 + 3600 })).toString("base64url")}.sig`;
  global.fetch = async (url) => {
    if (String(url).includes("/api/auth/refresh")) return { ok: true, json: async () => ({ accessToken: token }) };
    edgeCalls += 1;
    return { ok: true, json: async () => ({ totals: { total_tokens: edgeCalls } }) };
  };
  t.after(() => { global.fetch = realFetch; });
  const root = `http://127.0.0.1:${server.address().port}`;
  const endpoint = "/functions/tokentracker-usage-summary?from=2026-10-01&to=2026-10-02&account=1";
  const read = async (suffix = "") => {
    const response = await realFetch(root + endpoint + suffix);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-tokentracker-account-view"), "1");
    return (await response.json()).totals.total_tokens;
  };
  assert.equal(await read(), 1);
  assert.equal(await read(), 1);
  fs.writeFileSync(statePath, JSON.stringify({ offset: 200, updatedAt: "second" }));
  assert.equal(await read(), 2);
  assert.equal(await read(), 2);
  // A rewritten queue can finish a successful upload at the same byte offset.
  fs.writeFileSync(statePath, JSON.stringify({ offset: 200, updatedAt: "rewrite" }));
  assert.equal(await read(), 3);
  fs.writeFileSync(statePath, JSON.stringify({ offset: 0, updatedAt: "reset" }));
  assert.equal(await read(), 4);
  fs.unlinkSync(statePath);
  assert.equal(await read(), 5);
  assert.equal(await read(), 5);
  assert.equal(await read("&refresh=1"), 6);
  assert.equal(await read(), 6);
  assert.equal(edgeCalls, 6);
});

test("logout and account switch during an HTTP account read cannot restore the old relay token", async (t) => {
  const http = require("node:http");
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  const cookiePath = path.join(trackerDir, "relay-cookies.json");
  fs.writeFileSync(cookiePath, JSON.stringify({ insforge_refresh_token: "insforge_refresh_token=a; Path=/; HttpOnly; SameSite=Lax" }));
  const handler = freshHandler(queuePath);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    handler(req, res, url).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const root = `http://127.0.0.1:${server.address().port}`;
  const realFetch = global.fetch;
  const jwt = (sub) => `e30.${Buffer.from(JSON.stringify({ sub, exp: Date.now() / 1000 + 3600 })).toString("base64url")}.sig`;
  const tokenA = jwt("user-a");
  const tokenB = jwt("user-b");
  let started;
  const seenA = new Promise((resolve) => { started = resolve; });
  let release;
  const responseA = new Promise((resolve) => { release = resolve; });
  global.fetch = async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/auth/logout") return new Response("{}", { headers: { "content-type": "application/json" } });
    if (pathname === "/api/auth/sign-in") return new Response(JSON.stringify({ refreshToken: "b", csrfToken: "csrf-b" }), { headers: { "content-type": "application/json" } });
    if (pathname === "/api/auth/refresh") {
      const account = JSON.parse(init.body).refresh_token;
      return { ok: true, json: async () => ({ accessToken: account === "a" ? tokenA : tokenB, refreshToken: account === "a" ? "rotated-a" : "rotated-b" }) };
    }
    if (init.headers.Authorization === `Bearer ${tokenA}`) {
      started();
      return responseA;
    }
    return { ok: true, json: async () => ({ totals: { total_tokens: 987 } }) };
  };
  t.after(() => { global.fetch = realFetch; });
  const endpoint = "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&account=1";
  const oldRead = realFetch(root + endpoint);
  await seenA;
  assert.equal((await realFetch(root + "/api/auth/logout", { method: "POST" })).status, 200);
  assert.equal(fs.existsSync(cookiePath), false);
  assert.equal((await realFetch(root + "/api/auth/sign-in", { method: "POST" })).status, 200);
  const newRead = await realFetch(root + endpoint);
  assert.equal(newRead.headers.get("x-tokentracker-account-view"), "1");
  assert.equal((await newRead.json()).totals.total_tokens, 987);
  release({ ok: true, json: async () => ({ totals: { total_tokens: 12345 } }) });
  const oldResponse = await oldRead;
  assert.equal(oldResponse.status, 409);
  assert.equal(oldResponse.headers.get("x-tokentracker-account-view"), null);
  assert.deepEqual(await oldResponse.json(), { error: "Account session changed", code: "auth_session_changed" });
  const persisted = JSON.parse(fs.readFileSync(cookiePath, "utf8"));
  assert.ok(persisted.insforge_refresh_token.includes("rotated-b"));
  assert.ok(!persisted.insforge_refresh_token.includes("rotated-a"));
});

test("a late HTTP auth refresh cannot overwrite a new login's relay cookies", async (t) => {
  const http = require("node:http");
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  const cookiePath = path.join(trackerDir, "relay-cookies.json");
  fs.writeFileSync(cookiePath, JSON.stringify({ insforge_refresh_token: "insforge_refresh_token=a; Path=/; HttpOnly; SameSite=Lax" }));
  const handler = freshHandler(queuePath);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    handler(req, res, url).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const root = `http://127.0.0.1:${server.address().port}`;
  const realFetch = global.fetch;
  let started;
  const seenRefresh = new Promise((resolve) => { started = resolve; });
  let release;
  const responseA = new Promise((resolve) => { release = resolve; });
  global.fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/auth/refresh") { started(); return responseA; }
    return new Response(JSON.stringify(pathname === "/api/auth/sign-in" ? { refreshToken: "b", csrfToken: "csrf-b" } : {}), { headers: { "content-type": "application/json" } });
  };
  t.after(() => { global.fetch = realFetch; });
  const oldRefresh = realFetch(root + "/api/auth/refresh", { method: "POST" });
  await seenRefresh;
  assert.equal((await realFetch(root + "/api/auth/logout", { method: "POST" })).status, 200);
  assert.equal((await realFetch(root + "/api/auth/sign-in", { method: "POST" })).status, 200);
  release(new Response(JSON.stringify({ refreshToken: "rotated-a", csrfToken: "csrf-a" }), {
    headers: { "content-type": "application/json", "set-cookie": "insforge_refresh_token=rotated-a; Path=/; HttpOnly" },
  }));
  const response = await oldRefresh;
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(await response.json(), { error: "Account session changed", code: "auth_session_changed" });
  const persisted = JSON.parse(fs.readFileSync(cookiePath, "utf8"));
  assert.ok(persisted.insforge_refresh_token.startsWith("insforge_refresh_token=b;"));
  assert.ok(!persisted.insforge_refresh_token.includes("rotated-a"));
});
