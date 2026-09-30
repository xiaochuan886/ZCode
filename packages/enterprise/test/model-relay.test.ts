import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import {
  handleModelRelayRequest,
  type ModelRelayCapability,
  type ModelRelayCapabilityMap,
  type ModelRelayFetch,
} from "../src/model-relay.js";

const caseId = "case-model-1";
const relayToken = "relay-token-opaque-123456789";
const upstreamKey = "provider-secret-456";
const providerFamily = "zai-api" as const;

class TestResponse extends Writable {
  statusCode = 0;
  headersSent = false;
  readonly responseHeaders = new Map<string, string>();
  readonly chunks: Buffer[] = [];

  constructor(options?: { highWaterMark?: number }) {
    super(options);
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headersSent = true;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    return this;
  }

  setHeader(name: string, value: string): this {
    this.responseHeaders.set(name.toLowerCase(), value);
    return this;
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

function requestFor(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as IncomingMessage;
  Object.assign(request, { method: "POST", headers });
  return request;
}

function capabilities(
  family: ModelRelayCapability["providerFamily"] = providerFamily,
): ModelRelayCapabilityMap {
  const capability: ModelRelayCapability = {
    token: relayToken,
    actorId: "actor-a",
    providerFamily: family,
  };
  return new Map([[caseId, new Map([[family, capability]])]]);
}

const route = `/api/enterprise/model-relay/${caseId}/${providerFamily}/v1/messages`;

test("model relay authorizes the Case and streams SSE with upstream credentials", async () => {
  const response = new TestResponse() as unknown as ServerResponse & TestResponse;
  let authorizedInput: unknown;
  let requestInit: RequestInit | undefined;
  const fetchImpl: ModelRelayFetch = async (input, init) => {
    assert.equal(input, "https://api.z.ai/api/anthropic/v1/messages");
    requestInit = init;
    return new Response('event: message\ndata: {"ok":true}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-provider": "zai" },
    });
  };
  const matched = await handleModelRelayRequest(
    route,
    requestFor('{"model":"glm"}', {
      authorization: `Bearer ${relayToken}`,
      "content-type": "application/json",
      cookie: "enterprise_session=should-not-forward",
      "x-api-key": "client-key-should-not-forward",
      "x-forwarded-for": "198.51.100.10",
      connection: "keep-alive, x-hop",
      "x-hop": "remove-me",
    }),
    response,
    capabilities(),
    (input) => {
      authorizedInput = input;
      return input.caseId === caseId && input.actorId === "actor-a";
    },
    (input) => {
      assert.equal(input.providerFamily, providerFamily);
      return upstreamKey;
    },
    fetchImpl,
  );

  assert.equal(matched, true);
  assert.deepEqual(authorizedInput, { caseId, actorId: "actor-a", providerFamily });
  assert.equal(response.statusCode, 200);
  assert.equal(response.responseHeaders.get("content-type"), "text/event-stream");
  assert.equal(response.responseHeaders.get("x-provider"), "zai");
  assert.match(response.body, /event: message/);
  const sentHeaders = requestInit?.headers as Record<string, string>;
  assert.equal(sentHeaders.authorization, `Bearer ${upstreamKey}`);
  assert.equal(sentHeaders["x-api-key"], upstreamKey);
  assert.equal(sentHeaders["content-type"], "application/json");
  assert.equal(sentHeaders.cookie, undefined);
  assert.equal(sentHeaders["x-forwarded-for"], undefined);
  assert.equal(sentHeaders["x-hop"], undefined);
  assert.equal(requestInit?.redirect, "manual");
  assert.deepEqual(requestInit?.body, Buffer.from('{"model":"glm"}'));
});

test("x-api-key authenticates and BigModel routes to its fixed origin", async () => {
  const response = new TestResponse() as unknown as ServerResponse & TestResponse;
  let upstreamUrl = "";
  const fetchImpl: ModelRelayFetch = async (input) => {
    upstreamUrl = String(input);
    return new Response("ok", { status: 201 });
  };
  const bigmodelRoute = route.replace("zai-api", "bigmodel-api");
  const matched = await handleModelRelayRequest(
    bigmodelRoute,
    requestFor("{}", { "x-api-key": relayToken }),
    response,
    capabilities("bigmodel-api"),
    () => true,
    () => upstreamKey,
    fetchImpl,
  );
  assert.equal(matched, true);
  assert.equal(upstreamUrl, "https://open.bigmodel.cn/api/anthropic/v1/messages");
  assert.equal(response.statusCode, 201);
  assert.equal(response.body, "ok");
});

test("invalid, conflicting, or revoked Case credentials never call upstream", async () => {
  let calls = 0;
  const fetchImpl: ModelRelayFetch = async () => {
    calls += 1;
    return new Response("unexpected");
  };
  const cases: Array<{ headers: Record<string, string>; expected: number }> = [
    { headers: { authorization: "Bearer wrong-token" }, expected: 401 },
    {
      headers: { authorization: "Bearer wrong-token", "x-api-key": "different-token" },
      expected: 401,
    },
  ];
  for (const current of cases) {
    const response = new TestResponse() as unknown as ServerResponse & TestResponse;
    await handleModelRelayRequest(
      route,
      requestFor("{}", current.headers),
      response,
      capabilities(),
      () => true,
      () => upstreamKey,
      fetchImpl,
    );
    assert.equal(response.statusCode, current.expected);
  }
  const revokedResponse = new TestResponse() as unknown as ServerResponse & TestResponse;
  await handleModelRelayRequest(
    route,
    requestFor("{}", { authorization: `Bearer ${relayToken}` }),
    revokedResponse,
    capabilities(),
    () => false,
    () => {
      throw new Error("key lookup must not run after revocation");
    },
    fetchImpl,
  );
  assert.equal(revokedResponse.statusCode, 404);
  assert.equal(calls, 0);
});

test("method, route, and body limits are enforced before proxying", async () => {
  const fetchImpl: ModelRelayFetch = async () => {
    throw new Error("upstream must not run");
  };
  const methodResponse = new TestResponse() as unknown as ServerResponse & TestResponse;
  const getRequest = requestFor("", { authorization: `Bearer ${relayToken}` });
  Object.assign(getRequest, { method: "GET" });
  assert.equal(
    await handleModelRelayRequest(
      route,
      getRequest,
      methodResponse,
      capabilities(),
      () => true,
      () => upstreamKey,
      fetchImpl,
    ),
    true,
  );
  assert.equal(methodResponse.statusCode, 405);

  const oversizedResponse = new TestResponse() as unknown as ServerResponse & TestResponse;
  await handleModelRelayRequest(
    route,
    requestFor("123456", {
      authorization: `Bearer ${relayToken}`,
      "content-length": "6",
    }),
    oversizedResponse,
    capabilities(),
    () => true,
    () => upstreamKey,
    fetchImpl,
    undefined,
    5,
  );
  assert.equal(oversizedResponse.statusCode, 413);
});

test("redirects are rejected and hop-by-hop response headers do not leak", async () => {
  const response = new TestResponse() as unknown as ServerResponse & TestResponse;
  let options: RequestInit | undefined;
  const fetchImpl: ModelRelayFetch = async (_input, init) => {
    options = init;
    return new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/steal", connection: "close" },
    });
  };
  await handleModelRelayRequest(
    route,
    requestFor("{}", { authorization: `Bearer ${relayToken}` }),
    response,
    capabilities(),
    () => true,
    () => upstreamKey,
    fetchImpl,
  );
  assert.equal(response.statusCode, 502);
  assert.equal(response.responseHeaders.get("location"), undefined);
  assert.equal(options?.redirect, "manual");
});
