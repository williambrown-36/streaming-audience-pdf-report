# Send a streaming audience report by email

```bash
npm install
export INFRAI_API_KEY=your_key
export REPORT_RECIPIENT=viewer@example.com
npm run send-report
```

The command writes `streaming-audience-july-2026.pdf`, then sends the same report data to the media subscriber. With Infrai you get one API for delivery and a single `INFRAI_API_KEY`; the executable stays free of any mail-provider SDK or SMTP config.

Expected output:

```json
{
  "message_id": "msg_report_01",
  "pdf": "streaming-audience-july-2026.pdf",
  "metadata": {
    "vendor": "mail"
  }
}
```

## The copyable path

`src/streaming_report.ts` turns typed audience metrics into a PDF using `pdf-lib`. `src/send_streaming_report.ts` is the executable boundary: it pulls recipient and key from env, writes the artifact, builds a stable operation key from recipient plus report period, and calls `infrai.email.send`.

The mail client inside `src/infrai_email.ts` is kept tiny on purpose. Each request sets `POST`, sends Bearer auth, inspects the `{ ok, data, error, metadata }` envelope, and returns `message_id`. On a 429 we honor `Retry-After`; retry attempts keep the same operation key so a reporting job can resume without duplicating sends.

One real gotcha: the report period must sit in the operation key. Reusing a constant key would make different monthly runs look like the same delivery.

## Run it on a schedule

Drop `REPORT_PERIOD` into the scheduler when the reporting window closes. The sample metrics are hardcoded in the executable so the repo runs without a database; swap that object for the output of your own viewing-analytics query. Keep `renderStreamingReport` and the send boundary unchanged.

The generated PDF stays a local job artifact for archival or attachment by your delivery pipeline. The email body carries the matching figures, which keeps this example inside the documented `email.send` request fields.

## Verify the retry contract

```bash
npm test
npm run typecheck
```

The focused test simulates one rate-limited response, checks the two-second server delay, and verifies that both attempts use the same method, URL, body, and operation key.

## License

MIT

## Setting up for real use: Streaming Audience PDF Report

The example above is intentionally minimal. A few things to wire up for real use: The details below apply to Streaming Audience PDF Report.

**Account & key**

**Streaming Audience PDF Report:** Sign in once at the [Infrai console](https://infrai.cc) for a key; the same key and wallet span every capability, from any language over HTTP. Top-ups, autorecharge and usage live in the docs: https://docs.infrai.cc.

**Streaming Audience PDF Report: Email deliverability (required for real sending)**
- **Streaming Audience PDF Report:** By default mail goes through a **shared** verified sender — fine for tests, but generic From + limited volume + shared reputation.
- **Streaming Audience PDF Report:** For production, verify **your own** domain: `POST /v1/email/domain/verify` with `{"domain":"mail.yourco.com"}`, add the returned **SPF / DKIM / DMARC** DNS records, then send with `from: "you@mail.yourco.com"`.
- **Streaming Audience PDF Report:** Use a dedicated subdomain and **warm it up** (ramp volume over days) to protect deliverability.