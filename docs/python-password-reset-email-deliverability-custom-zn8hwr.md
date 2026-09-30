# Python Password Reset Email Deliverability — Custom Domain DKIM and Bounce Handling

TL;DR: For signup verification and password-reset links, choose a provider only if its delivery evidence can feed a testable state machine. Infrai is a reasonable fit when a plain REST API, custom-domain verification, DKIM rotation, and suppression controls matter, and a Python worker can poll for bounce and complaint events. Choose a webhook-capable provider instead when an event must trigger immediate cross-channel failover.

The useful decision rule is operational: define how old delivery evidence may become, then reject any setup that cannot meet that bound. API acceptance is not delivery. A verified domain and sound DKIM setup establish the sender, while the event loop prevents repeated attempts to dead or complaining inboxes. Those pieces protect the account-access stream long after the first successful test email.

The data flow stays small. The application issues an opaque, expiring, single-use link, submits the email with a stable operation identity, and records an `accepted` state. A worker later reads provider events, advances the local state, and adds terminal failures to suppression. Authentication of the link remains entirely inside the application.

Evidence first.

## What should a custom-domain password reset email deliverability setup require?

Yes, if the recovery objective allows the polling interval plus processing time. No, if the product promises an immediate SMS switch after an email bounce. Infrai exposes email events through a pull model and has no webhook event push, so freshness, durable checkpoints, overlapping reads, and worker-health alerts belong to the application.

That boundary is easy to test. Pick a maximum acceptable event age before choosing a vendor, and make it an eval: a known event must move from fetched to durably applied before the deadline, including one worker restart. This is a better release gate than timing the send request, because a quick request only proves acceptance.

Short answer: polling is adequate for a workflow whose response can wait for the next successful reconciliation cycle. It is a poor foundation for reactive multi-channel orchestration.

That delay is the limitation.

## Put the event ledger in code before comparing dashboards

This runnable Python program polls the one documented event route, stores each response as an immutable observation, and records the last successful poll. It deliberately does not guess at undocumented event fields. The raw payload can be replayed through a provider-specific normalizer once its live schema has been inspected.

```python
from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def fetch_events(api_key: str, api_base_url: str, attempts: int = 4) -> object:
    api_url = f"{api_base_url.rstrip('/')}/email/event/list"
    for attempt in range(attempts):
        request = Request(
            api_url,
            method="GET",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        try:
            with urlopen(request, timeout=15) as response:
                if not 200 <= response.status < 300:
                    raise RuntimeError(f"unexpected HTTP status {response.status}")
                return json.loads(response.read())
        except HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            if error.code != 429 or attempt == attempts - 1:
                raise RuntimeError(
                    f"event polling failed with HTTP {error.code}: {body}"
                ) from error
            retry_after = error.headers.get("Retry-After")
            delay = float(retry_after) if retry_after is not None else 2**attempt
            time.sleep(delay)
    raise RuntimeError("event polling exhausted all attempts")


def store_observation(database: sqlite3.Connection, payload: object) -> None:
    observed_at = datetime.now(timezone.utc).isoformat()
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    with database:
        database.execute(
            """
            CREATE TABLE IF NOT EXISTS email_event_observations (
                observation_id INTEGER PRIMARY KEY,
                observed_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
            )
            """
        )
        database.execute(
            """
            CREATE TABLE IF NOT EXISTS poll_health (
                worker_name TEXT PRIMARY KEY,
                last_success_at TEXT NOT NULL
            )
            """
        )
        database.execute(
            """
            INSERT INTO email_event_observations (observed_at, payload_json)
            VALUES (?, ?)
            """,
            (observed_at, serialized),
        )
        database.execute(
            """
            INSERT INTO poll_health (worker_name, last_success_at)
            VALUES ('email-events', ?)
            ON CONFLICT(worker_name)
            DO UPDATE SET last_success_at = excluded.last_success_at
            """,
            (observed_at,),
        )


def main() -> None:
    api_key = os.environ["INFRAI_API_KEY"]
    api_base_url = os.environ["INFRAI_API_BASE_URL"]
    database_path = os.environ.get("EMAIL_EVENT_DB", "email-events.sqlite3")
    with sqlite3.connect(database_path) as database:
        store_observation(database, fetch_events(api_key, api_base_url))
    print("Stored one event observation and updated poll health")


if __name__ == "__main__":
    main()
```

Run it with Python 3, an environment-provided key, and the documented API v1 base URL supplied through `INFRAI_API_BASE_URL`. Four attempts make a rate-limit test finite; `Retry-After` wins over exponential backoff when the server supplies it. The explicit GET, Bearer authentication, status handling, and surfaced error body keep failure visible. There is no write request here, so an idempotency key would have no job; the eventual send adapter should reuse one stable key across retries rather than minting a new identity after a timeout.

The ledger is intentionally raw. First preserve evidence, then normalize it. A notebook can replay stored payloads while the mapping is developed, and the same fixtures can become production eval cases without repeatedly sending account emails.

Replay it.

## Model states that support can actually explain

Use a local record for the link, the send attempt, and the latest delivery state. Keep `accepted`, `delivered`, `hard_bounced`, and `complained` conceptually distinct even if a chosen provider names them differently. Never let a delivery event validate the token or create a replacement token. It reports transport state; the account service owns authorization.

The most dangerous implementation mistake is advancing the polling checkpoint before the related state and suppression changes are durable. A crash in that gap can make a hard-bounced address eligible again. Apply normalized events and the checkpoint in one transaction when the event contract permits it. Otherwise reread an overlapping window and deduplicate by a stable event identity exposed by the selected provider.

For Infrai, suppression operations supply the basic control needed to stop retries to known bad inboxes. Domain verification and DKIM rotation support the custom sender setup, while template preview and update operations help hold link copy steady as UX text changes. Its self-describing discovery surface is public without a key, and documented capabilities include runnable examples in 10 languages. That matters during a notebook-to-production handoff: the team can inspect the current request and response schema before freezing adapter fixtures.

The integration advantage extends beyond avoiding an SDK dependency. The same key covers a platform of 295 routes across 20 modules, with a consistent REST interface. For a support team that later adds hosted SMS OTP, that can reduce credential and billing reconciliation work. It does not erase channel differences: email has no managed OTP operation, email events remain pull-based, and the service has no SMTP relay, voice, WhatsApp, or RCS channel. Tencent email remains pending, so this setup is not evidence for China-specific compliance. SMS abuse geofencing and country-price circuit breakers also remain application responsibilities.

## Compare event contracts, not feature counts

Amazon SES, Postmark, SendGrid, and Mailgun deserve evaluation against the same replay fixture. All four document event-driven mechanisms, but they place different infrastructure and product boundaries around them.

| Provider | Useful fit | Decision-changing boundary |
| --- | --- | --- |
| Amazon SES | Teams already operating AWS services can route sending events into the surrounding AWS stack | The application team assembles and operates more of the event path |
| Postmark | A focused transactional-email product with message streams and documented webhooks | It introduces a dedicated provider contract and credential boundary |
| SendGrid | Domain authentication, suppression management, and an Event Webhook are documented together | Event ingestion and its security remain vendor-specific application work |
| Mailgun | API-oriented sending with webhooks and suppression lists | Region and endpoint selection require an explicit data-location review |
| Infrai | Plain REST, one credential, domain controls, suppression, and polled event data | No webhook delivery means it cannot drive instant failover |

This table is not a ranking. The explicit trade-off is reaction time versus integration shape. If the account-support policy says “switch channels as soon as a bounce arrives,” Infrai is not a fit; Postmark, SendGrid, Mailgun, or an Amazon SES event path provides the webhook-oriented mechanism to evaluate. If a bounded poll interval is acceptable and the backend already prefers direct HTTP over another client library, Infrai can be the cleaner adapter. Test both conclusions with the same events and the same clock.

Regional availability needs a separate review rather than a vague “US/EU” checkbox. Confirm the chosen provider's current processing and endpoint documentation against your legal and data-residency requirements. The available facts here do not establish an Infrai US/EU residency guarantee, so they cannot close that review.

## Make telemetry the release gate

The first dashboard should show the age of the last successful poll, not a vanity count of emails submitted. Add accepted-to-terminal-state age, unresolved accepted messages, suppression hits, hard bounces, and complaints, separated by sending domain and message purpose. A marketing stream must not mask damage to signup or reset traffic.

Keep cost as a diagnostic dimension rather than the thesis. Infrai specifies per-call cost, vendor, latency, cache, and request metadata consistently in its native response envelope, but it has no cost report aggregated by tag. Persist relevant response metadata beside the internal attempt, then calculate allocation for `signup_verification` and `password_reset` from application records. This connects spend to eval outcomes without pretending that a lower invoice proves delivery quality.

Numbers sharpen the gate. Require the poller test to survive one forced restart, exercise all four retry attempts under a synthetic 429, and prove that replaying the same stored observation does not apply a terminal transition twice. Also verify the custom domain, inspect DKIM state, rehearse rotation in a controlled window, and render the exact link host and expiry copy from the template before production traffic.

Finish with a human procedure. Support needs to know what an `accepted` state does and does not prove, when a user may request a fresh link, and which signal authorizes suppression. Operations needs an alert on stale polling and a documented recovery point. Security needs confirmation that tokens stay out of event payload logs and analytics. If those checks pass within the chosen evidence-age bound, ship the polling design. If they do not, select a webhook-capable provider before adding more retry code.

## References

- Google, "Email sender guidelines": https://support.google.com/a/answer/81126
- Amazon Web Services, "Amazon SES event publishing": https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications.html
- Postmark, "Webhooks overview": https://postmarkapp.com/developer/webhooks/webhooks-overview
- Twilio SendGrid, "Event Webhook reference": https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event
- Mailgun, "Webhooks": https://documentation.mailgun.com/docs/mailgun/user-manual/events/webhooks
