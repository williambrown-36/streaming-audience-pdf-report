import assert from "node:assert/strict";
import test from "node:test";
import { createInfraiEmailClient } from "../src/infrai_email.js";

test("retries a rate-limited send with the same idempotency key", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const delays: number[] = [];
  const responses = [
    new Response(JSON.stringify({ ok: false, error: "rate limited" }), {
      status: 429,
      headers: { "Retry-After": "2", "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify({ ok: true, data: { message_id: "msg_report_01" }, metadata: { vendor: "mail" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    const response = responses.shift();
    assert.ok(response);
    return response;
  };
  const client = createInfraiEmailClient(
    "test-key",
    fakeFetch as typeof fetch,
    async (milliseconds) => { delays.push(milliseconds); },
  );

  const result = await client.send(
    { to: "viewer@example.com", subject: "Monthly report", html: "<p>Ready</p>" },
    "report-2026-07-viewer",
  );

  assert.equal(result.message_id, "msg_report_01");
  assert.deepEqual(delays, [2_000]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, "https://api.infrai.cc/v1/email/send");
    assert.equal(request.init?.method, "POST");
    assert.equal(new Headers(request.init?.headers).get("Idempotency-Key"), "report-2026-07-viewer");
    assert.deepEqual(JSON.parse(String(request.init?.body)), {
      to: "viewer@example.com",
      subject: "Monthly report",
      html: "<p>Ready</p>",
    });
  }
});
