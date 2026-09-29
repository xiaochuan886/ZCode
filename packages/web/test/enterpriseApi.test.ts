import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnterpriseClient,
  isCompleteCaseDraft,
  statusChoices,
} from "../src/enterprise/api.ts";

test("Case creation requires an object, title and category", () => {
  assert.equal(
    isCompleteCaseDraft({ serviceSpaceId: "s", serviceObjectId: "", title: "t", category: "c" }),
    false,
  );
  assert.equal(
    isCompleteCaseDraft({ serviceSpaceId: "s", serviceObjectId: "o", title: " ", category: "c" }),
    false,
  );
  assert.equal(
    isCompleteCaseDraft({ serviceSpaceId: "s", serviceObjectId: "o", title: "t", category: "c" }),
    true,
  );
});

test("enterprise mutations carry CSRF and cookies", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = createEnterpriseClient(async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: "case-1" }), { status: 200 });
  });
  await client.activateCase("case-1", "csrf-1");
  assert.equal(calls[0]?.url, "/api/enterprise/cases/case-1/activate");
  assert.equal(calls[0]?.init?.credentials, "same-origin");
  assert.equal(new Headers(calls[0]?.init?.headers).get("X-CSRF-Token"), "csrf-1");
});

test("status choices expose only valid next transitions", () => {
  assert.deepEqual(statusChoices("open"), ["open", "in_progress"]);
  assert.deepEqual(statusChoices("resolved"), ["resolved", "closed", "in_progress"]);
});

test("native session binding targets the active Case endpoint", async () => {
  let sent: { url: string; body: unknown; csrf: string | null } | undefined;
  const client = createEnterpriseClient(async (url, init) => {
    sent = {
      url: String(url),
      body: JSON.parse(String(init?.body)),
      csrf: new Headers(init?.headers).get("X-CSRF-Token"),
    };
    return new Response("{}", { status: 200 });
  });
  await client.bindSession("case-1", "task-1", "csrf-1");
  assert.deepEqual(sent, {
    url: "/api/enterprise/cases/case-1/session",
    body: { sessionId: "task-1" },
    csrf: "csrf-1",
  });
});

test("ordinary server is identified only by a missing enterprise route", async () => {
  const absent = createEnterpriseClient(async () => new Response(null, { status: 404 }));
  assert.equal(await absent.bootstrap(), null);
  const broken = createEnterpriseClient(async () => new Response(null, { status: 503 }));
  await assert.rejects(() => broken.bootstrap());
});
