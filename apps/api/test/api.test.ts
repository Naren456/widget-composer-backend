import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { ToolError } from "../src/modules/connectors/composio.js";
import { toFlat } from "../src/spec/flat.js";
import { validateSpec, type WidgetSpec } from "../src/spec/widget-spec.js";
import { fakeConnectors, sampleSpec, scriptedLlm, startServer, type TestServer } from "./helpers.js";

const flatOf = (spec: unknown) => {
  const checked = validateSpec(spec);
  assert.ok(checked.ok);
  return JSON.stringify(toFlat(checked.spec as WidgetSpec));
};

describe("auth", () => {
  let s: TestServer;
  before(async () => (s = await startServer()));
  after(() => s.close());

  test("protected routes need a valid token", async () => {
    assert.equal((await s.request("/v1/widgets")).status, 401);
    assert.equal((await s.request("/v1/widgets", { token: "v1.not.a.token" })).status, 401);
    const { accessToken } = await s.signUp();
    assert.equal((await s.request("/v1/widgets", { token: accessToken })).status, 200);
    // A tampered user id breaks the signature.
    const parts = accessToken.split(".");
    parts[1] = "00000000-0000-4000-8000-000000000000";
    assert.equal((await s.request("/v1/widgets", { token: parts.join(".") })).status, 401);
  });

  test("refresh tokens rotate, and reusing one signs out every session", async () => {
    const first = await s.signUp();
    const second = await s.request("/v1/auth/refresh", { body: { refreshToken: first.refreshToken } });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.refreshToken, first.refreshToken);
    assert.equal(second.body.userId, first.userId);

    const replay = await s.request("/v1/auth/refresh", { body: { refreshToken: first.refreshToken } });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, "REFRESH_TOKEN_REUSED");
    // The legitimate newer token is revoked too.
    assert.equal((await s.request("/v1/auth/refresh", { body: { refreshToken: second.body.refreshToken } })).status, 401);
  });
});

describe("widgets", () => {
  let s: TestServer;
  let token: string;
  before(async () => {
    s = await startServer();
    token = (await s.signUp()).accessToken;
  });
  after(() => s.close());

  test("create, version, publish, roll back, archive and delete", async () => {
    const created = await s.request("/v1/widgets", { token, body: { spec: sampleSpec("PRs") } });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal(created.body.status, "draft");
    assert.equal(created.body.latestVersion.versionNumber, 1);

    const v2 = await s.request(`/v1/widgets/${id}/versions`, { token, body: { spec: sampleSpec("PRs v2") } });
    assert.equal(v2.body.versionNumber, 2);
    assert.equal(v2.body.source, "manual");

    const published = await s.request(`/v1/widgets/${id}/publish`, { token, body: { versionId: v2.body.id } });
    assert.equal(published.body.status, "published");
    assert.equal(published.body.currentVersionId, v2.body.id);
    assert.equal(published.body.name, "PRs v2");

    const versions = (await s.request(`/v1/widgets/${id}/versions`, { token })).body.versions;
    assert.deepEqual(versions.map((v: { versionNumber: number }) => v.versionNumber), [2, 1]);
    const rollback = await s.request(`/v1/widgets/${id}/publish`, { token, body: { versionId: versions[1].id } });
    assert.equal(rollback.body.currentVersionId, versions[1].id);

    const archived = await s.request(`/v1/widgets/${id}`, { method: "PATCH", token, body: { archived: true } });
    assert.equal(archived.body.status, "archived");
    assert.equal((await s.request("/v1/widgets", { token })).body.widgets.length, 0);
    assert.equal((await s.request(`/v1/widgets/${id}/publish`, { token, body: { versionId: v2.body.id } })).status, 409);

    assert.equal((await s.request(`/v1/widgets/${id}`, { method: "DELETE", token })).status, 204);
    assert.equal((await s.request(`/v1/widgets/${id}`, { token })).status, 404);
  });

  test("invalid specs are rejected with every issue", async () => {
    const bad = sampleSpec();
    (bad.root.children[0] as { text: string }).text = "{{nope.count}}";
    const res = await s.request("/v1/widgets", { token, body: { spec: bad } });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "INVALID_SPEC");
    assert.ok(res.body.error.details.length > 0);

    const validate = await s.request("/v1/widgets/validate", { token, body: { spec: bad } });
    assert.equal(validate.body.valid, false);
  });

  test("another user's widget behaves as if it does not exist", async () => {
    const mine = (await s.request("/v1/widgets", { token, body: { spec: sampleSpec() } })).body;
    const other = (await s.signUp()).accessToken;
    assert.equal((await s.request(`/v1/widgets/${mine.id}`, { token: other })).status, 404);
    assert.equal((await s.request(`/v1/widgets/${mine.id}`, { method: "DELETE", token: other })).status, 404);
    assert.equal(
      (await s.request(`/v1/widgets/${mine.id}/versions`, { token: other, body: { spec: sampleSpec() } })).status,
      404,
    );
    assert.equal(
      (await s.request(`/v1/widgets/${mine.id}/publish`, { token: other, body: { versionId: mine.latestVersion.id } })).status,
      404,
    );
    assert.equal((await s.request(`/v1/widgets/${mine.id}/data`, { token: other })).status, 404);
    assert.equal((await s.request("/v1/widgets/not-a-uuid", { token })).status, 404);
  });

  test("home-screen instances register idempotently per device slot", async () => {
    const w = (await s.request("/v1/widgets", { token, body: { spec: sampleSpec() } })).body;
    const body = { deviceId: "device-0001", platformWidgetId: 42, renderer: "android-remoteviews-v1" };
    const a = await s.request(`/v1/widgets/${w.id}/instances`, { token, body });
    const b = await s.request(`/v1/widgets/${w.id}/instances`, { token, body });
    assert.equal(a.status, 201);
    assert.equal(a.body.id, b.body.id);
    assert.equal((await s.request(`/v1/widgets/${w.id}/instances/${a.body.id}`, { method: "DELETE", token })).status, 204);
  });
});

describe("generation", () => {
  test("returns 503 when no AI provider is configured", async () => {
    const s = await startServer({ llm: null });
    const { accessToken } = await s.signUp();
    const res = await s.request("/v1/widgets/generate", { token: accessToken, body: { prompt: "My open pull requests" } });
    assert.equal(res.status, 503);
    await s.close();
  });

  test("repairs an invalid reply using the validator's issues, then records the run", async () => {
    const broken = JSON.parse(flatOf(sampleSpec()));
    broken.nodes[1].text = "{{missing.count}}";
    const llm = scriptedLlm([JSON.stringify(broken), flatOf(sampleSpec())]);
    const s = await startServer({ llm });
    const { accessToken } = await s.signUp();

    const res = await s.request("/v1/widgets/generate", { token: accessToken, body: { prompt: "My open pull requests" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.spec.name, "My PRs");
    assert.equal(llm.sent.length, 2);
    assert.match(llm.sent[1], /undeclared data source "missing"/);

    const run = await s.db.generationRun.findMany({ select: { status: true, attempts: true } }).then((runs) => runs[0]);
    assert.deepEqual(run, { status: "succeeded", attempts: 2 });

    // The run id links a saved widget to its generation.
    const saved = await s.request("/v1/widgets", { token: accessToken, body: { spec: res.body.spec, generationRunId: res.body.generationRunId } });
    assert.equal(saved.body.latestVersion.source, "generated");
    await s.close();
  });

  test("gives up after three invalid replies and reports the issues", async () => {
    const s = await startServer({ llm: scriptedLlm(["not json"]) });
    const { accessToken } = await s.signUp();
    const res = await s.request("/v1/widgets/generate", { token: accessToken, body: { prompt: "My open pull requests" } });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "GENERATION_INVALID");
    const run = await s.db.generationRun.findMany({ select: { status: true, attempts: true } }).then((runs) => runs[0]);
    assert.deepEqual(run, { status: "invalid", attempts: 3 });
    await s.close();
  });

  test("unsupported requests and refusals become clear 422s", async () => {
    const unsupported = { ...JSON.parse(flatOf(sampleSpec())), unsupported: "Weather data is not available." };
    let s = await startServer({ llm: scriptedLlm([JSON.stringify(unsupported)]) });
    let token = (await s.signUp()).accessToken;
    let res = await s.request("/v1/widgets/generate", { token, body: { prompt: "Weather in Delhi" } });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "UNSUPPORTED_REQUEST");
    assert.equal(res.body.error.message, "Weather data is not available.");
    await s.close();

    s = await startServer({ llm: scriptedLlm([{ kind: "refusal", usage: { inputTokens: 1, outputTokens: 0 } }]) });
    token = (await s.signUp()).accessToken;
    res = await s.request("/v1/widgets/generate", { token, body: { prompt: "something declined" } });
    assert.equal(res.body.error.code, "GENERATION_REFUSED");
    await s.close();
  });

  test("an edit sends the current widget to the model", async () => {
    const llm = scriptedLlm([flatOf(sampleSpec("Edited"))]);
    const s = await startServer({ llm });
    const { accessToken } = await s.signUp();
    const w = (await s.request("/v1/widgets", { token: accessToken, body: { spec: sampleSpec() } })).body;
    const res = await s.request("/v1/widgets/generate", { token: accessToken, body: { prompt: "Make the title larger", widgetId: w.id } });
    assert.equal(res.body.spec.name, "Edited");
    assert.match(llm.sent[0], /Current widget:/);
    assert.match(llm.sent[0], /Make the title larger/);
    await s.close();
  });

  test("generation is rate limited per user", async () => {
    const s = await startServer({ llm: scriptedLlm([flatOf(sampleSpec())]) });
    const { accessToken } = await s.signUp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await s.request("/v1/widgets/generate", { token: accessToken, body: { prompt: "My open pull requests" } })).status);
    }
    assert.equal(statuses.filter((x) => x === 200).length, 10);
    assert.equal(statuses.at(-1), 429);
    await s.close();
  });
});

describe("GitHub through Composio, and widget data", () => {
  let searchMode: "ok" | "fail" | "revoked" = "ok";
  const composio = fakeConnectors((_userId, tool, args) => {
    assert.equal(tool, "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS");
    if (searchMode === "fail") throw new ToolError("Composio failed: GitHub returned 500", "upstream");
    if (searchMode === "revoked") throw new ToolError("Composio failed: Bad credentials", "unauthorized");
    assert.match(String(args.q), /author:@me/);
    return {
      data: {
        total_count: 2,
        items: [
          { title: "Add refresh", html_url: "https://github.com/a/b/pull/1", repository_url: "https://api.github.com/repos/a/b", number: 1, updated_at: "2026-10-30T00:00:00Z", user: { login: "octo" } },
          { title: "Evil link", html_url: "javascript:alert(1)", repository_url: "https://api.github.com/repos/a/b", number: 2, updated_at: "2026-10-30T00:00:00Z", user: null },
        ],
      },
    };
  });

  let s: TestServer;
  let token: string;
  let userId: string;
  before(async () => {
    s = await startServer({ connectors: composio });
    ({ accessToken: token, userId } = await s.signUp());
  });
  after(() => s.close());

  const setAccount = (status: "active" | "needs_reauth") =>
    composio.accountsByUser.set(userId, [{ id: "ca_github1", status, createdAt: "2026-10-31T00:00:00Z" }]);

  test("without COMPOSIO_API_KEY, connect answers 503 and previews use sample data", async () => {
    const bare = await startServer();
    const t = (await bare.signUp()).accessToken;
    assert.equal((await bare.request("/v1/connectors/github/connect", { token: t, method: "POST" })).status, 503);
    assert.equal((await bare.request("/v1/widgets/preview-data", { token: t, body: { spec: sampleSpec() } })).body.sample, true);
    await bare.close();
  });

  test("preview uses flagged sample data before GitHub is connected", async () => {
    const res = await s.request("/v1/widgets/preview-data", { token, body: { spec: sampleSpec() } });
    assert.equal(res.body.sample, true);
    assert.equal(res.body.data.prs.items.length, 3);
  });

  test("widget data asks for a connection before GitHub is connected", async () => {
    const w = (await s.request("/v1/widgets", { token, body: { spec: sampleSpec() } })).body;
    const res = await s.request(`/v1/widgets/${w.id}/data`, { token });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "CONNECTOR_REQUIRED");
  });

  test("connect returns a Composio link whose callback forwards to the app", async () => {
    const start = await s.request("/v1/connectors/github/connect", { token, method: "POST" });
    assert.match(start.body.authorizeUrl, /^https:\/\/connect\.composio\.test\/github/);
    assert.equal(composio.links.at(-1), "https://api.test/v1/connectors/github/callback");
    const ok = await s.request("/v1/connectors/github/callback?status=success&connected_account_id=ca_1");
    assert.equal(ok.headers.get("location"), "web2widgets://connections?provider=github&status=connected");
    const failed = await s.request("/v1/connectors/github/callback?status=failed");
    assert.equal(failed.headers.get("location"), "web2widgets://connections?provider=github&status=error");
  });

  test("data is fetched, normalised, cached, and kept when a refresh fails", async () => {
    setAccount("active");
    const list = await s.request("/v1/connectors", { token });
    assert.deepEqual(list.body.connectors.map((c: { id: string; status: string }) => [c.id, c.status]), [["ca_github1", "active"]]);
    assert.equal((await s.request("/v1/connectors/github/connect", { token, method: "POST" })).status, 409);

    const w = (await s.request("/v1/widgets", { token, body: { spec: sampleSpec() } })).body;
    composio.calls.length = 0;
    const first = await s.request(`/v1/widgets/${w.id}/data`, { token });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.prs.count, 2);
    assert.equal(first.body.data.prs.items[0].repo, "a/b");
    assert.equal(first.body.data.prs.items[1].url, "https://github.com/", "non-GitHub links are never passed through");
    assert.equal(first.body.stale, false);

    await s.request(`/v1/widgets/${w.id}/data`, { token });
    assert.equal(composio.calls.length, 1, "second read is served from the snapshot");

    searchMode = "fail";
    const failed = await s.request(`/v1/widgets/${w.id}/data?refresh=true`, { token });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.data.prs.count, 2, "last good data is kept");
    assert.match(failed.body.lastError, /Composio could not complete the connected-account request/);

    searchMode = "revoked";
    const revoked = await s.request(`/v1/widgets/${w.id}/data?refresh=true`, { token });
    assert.equal(revoked.body.data.prs.count, 2);
    assert.match(revoked.body.lastError, /revoked/);
    searchMode = "ok";

    setAccount("needs_reauth");
    const stale = await s.request(`/v1/widgets/${w.id}/data?refresh=true`, { token });
    assert.match(stale.body.lastError, /Reconnect GitHub/);
    // Reconnecting replaces the broken account.
    assert.equal((await s.request("/v1/connectors/github/connect", { token, method: "POST" })).status, 200);
    assert.deepEqual(composio.accountsByUser.get(userId), []);
  });

  test("disconnect removes only the user's own account", async () => {
    setAccount("active");
    const other = (await s.signUp()).accessToken;
    assert.equal((await s.request("/v1/connectors/ca_github1", { method: "DELETE", token: other })).status, 404);
    assert.equal((await s.request("/v1/connectors/ca_github1", { method: "DELETE", token })).status, 204);
    assert.deepEqual((await s.request("/v1/connectors", { token })).body.connectors, []);
  });
});

describe("http", () => {
  test("CORS answers only allow-listed origins; malformed and oversized bodies get clean errors", async () => {
    const s = await startServer();
    const allowed = await s.request("/health", { headers: { origin: "http://localhost:8081" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:8081");
    const denied = await s.request("/health", { headers: { origin: "https://evil.example" } });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);

    assert.equal((await s.request("/v1/auth/refresh", { body: "{bad" })).body.error.code, "INVALID_REQUEST");
    const big = await s.request("/v1/auth/refresh", { body: { refreshToken: "x".repeat(70_000) } });
    assert.equal(big.status, 413);
    assert.equal((await s.request("/nope")).status, 404);
    await s.close();
  });
});
