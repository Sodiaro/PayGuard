# API

The HTTP contract of PayGuard: authentication, payments, idempotency, provider webhooks, rate
limits and errors. With `SWAGGER_ENABLED=true` the same endpoints are browsable at `/docs` (use
**Authorize** to send a key). Why the behaviour is what it is is explained in
[architecture.md](architecture.md).

> Every payment is processed by the built-in simulator, whose result comes from operator
> configuration, never from the request. No real money moves.

- [Authentication](#authentication)
- [Merchant endpoints](#merchant-endpoints)
- [Payments](#payments)
- [Refunds](#refunds)
- [Idempotency](#idempotency)
- [Currencies and amounts](#currencies-and-amounts)
- [Merchant webhooks](#merchant-webhooks)
- [Provider webhooks](#provider-webhooks)
- [Rate limiting](#rate-limiting)
- [Errors](#errors)

## Authentication

Every endpoint except `/health*` and `/v1/webhooks/*` requires a merchant API key in the
`Authorization: Bearer` header; keys in query strings or bodies are ignored. Keys are issued by
the operator CLI (`merchant:create`, `key:create`) and shown once.

Missing, malformed, unknown, wrong-secret, revoked, expired and suspended-merchant credentials all
return the same `401 Invalid API key` (or `Missing API key` when there is no header), with a
`WWW-Authenticate: Bearer` challenge. The specific reason goes to the server log only.

The merchant is always the one that owns the key. No endpoint accepts a merchant ID, and another
merchant's resource answers `404`, exactly like one that does not exist.

## Merchant endpoints

| Method and path        | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `GET /v1/merchants/me` | The merchant that owns the presented key                     |
| `GET /v1/api-keys`     | The caller's keys (prefix, label, status, dates; no secrets) |
| `GET /v1/api-keys/:id` | One of the caller's keys; 404 for anyone else's              |

There are deliberately no HTTP endpoints for registering merchants or managing keys.

## Payments

| Method and path                          | Description                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /v1/payments`                      | Create a payment and queue its first attempt. Requires `Idempotency-Key`.              |
| `POST /v1/payments/:id/retry`            | Queue a new attempt for an eligible `FAILED` payment. Requires `Idempotency-Key`.      |
| `POST /v1/payments/:id/capture`, `/void` | Capture or void a manual-capture authorization; see [Manual capture](#manual-capture). |
| `GET /v1/payments`                       | The caller's payments, newest first, filtered and paginated (see below).               |
| `GET /v1/payments/:id`                   | A payment owned by the caller, with its attempts. 404 for anyone else's or none.       |

Processing is asynchronous: both `POST` operations return `202 Accepted` with the payment
`PENDING`, and the outcome appears on `GET /v1/payments/:id` once a worker has processed it
(normally within about a second). An outcome the provider did not confirm keeps the payment
`PENDING` until reconciliation establishes it.

Request body. Only these fields are accepted; anything else, such as `merchantId`, `status` or
provider data, is rejected with 400:

| Field           | Type    | Rules                                                                                              |
| --------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `amount`        | integer | Minor units, `1` to `1000000000000`. JSON numbers only, never strings or decimals.                 |
| `currency`      | string  | One of the [supported ISO 4217 codes](#currencies-and-amounts), uppercase.                         |
| `reference`     | string  | Optional, 1-64 of `A-Z a-z 0-9 . _ : / # -`. Your own label; not unique, not used for idempotency. |
| `captureMethod` | string  | Optional: `AUTOMATIC` (default) charges on submission; `MANUAL` only authorizes.                   |

A processed payment, as returned by `GET` (a new payment looks the same with `status: "PENDING"`
and one `PENDING` attempt without a reference):

```json
{
  "id": "01a16b6d-bf6d-765f-98fb-39c95d75fe23",
  "amount": 500000,
  "currency": "NGN",
  "status": "SUCCEEDED",
  "captureMethod": "AUTOMATIC",
  "reference": "order_10042",
  "failureCode": null,
  "amountCaptured": 500000,
  "amountRefunded": 0,
  "actions": [],
  "attempts": [
    {
      "id": "01a16b6d-bf72-73ea-83b1-f39d1c06083f",
      "attemptNumber": 1,
      "provider": "simulator",
      "status": "SUCCEEDED",
      "providerReference": "sim_7b4affd0040515a3582e3ba9",
      "failureCode": null,
      "createdAt": "2026-10-24T01:01:56.974Z",
      "completedAt": "2026-10-24T01:01:57.998Z"
    }
  ],
  "createdAt": "2026-10-24T01:01:56.974Z",
  "updatedAt": "2026-10-24T01:01:58.019Z"
}
```

| Status | When                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------- |
| `202`  | Payment created, or retry accepted; the new attempt is queued and the payment is `PENDING`.             |
| `200`  | Replay of an earlier request with the same key; header `Idempotent-Replayed: true`. Current state.      |
| `400`  | Invalid body or `Idempotency-Key` (field-level `details`), malformed JSON, bad payment id.              |
| `401`  | Missing or invalid API key.                                                                             |
| `404`  | Payment does not exist or belongs to another merchant (indistinguishable by design).                    |
| `409`  | `Idempotency-Key` already used with a different request, or the payment is not eligible for a retry.    |
| `429`  | Rate limit exceeded; `Retry-After` gives the seconds to wait.                                           |
| `500`  | Unexpected server error; generic message, details only in the server log. Nothing is left half-created. |

Internal fields such as the idempotency key, request fingerprint and raw provider data are never
returned.

**Statuses.** Payments are `PENDING`, `SUCCEEDED` or `FAILED`, and with manual capture also
`AUTHORIZED` and `CANCELED`; attempts are `PENDING`, `SUCCEEDED` or `FAILED`. See
[the lifecycle](architecture.md#payment-lifecycle). A failed payment carries `failureCode`
`DECLINED` (the provider refused the payment) or `PROVIDER_UNAVAILABLE` (nothing was attempted).
`amountCaptured` is what a `SUCCEEDED` payment charged (`null` otherwise). Refunds do not change a
payment's status: a refunded payment stays `SUCCEEDED`, and `amountRefunded` reports what its
succeeded refunds returned.

**Listing.** `GET /v1/payments` returns `{ "data": [...], "nextCursor": "..." }`, where each item
has the same shape as `GET /v1/payments/:id`. Query parameters, all optional and combined with AND:

| Parameter     | Rules                                                                             |
| ------------- | --------------------------------------------------------------------------------- |
| `status`      | `PENDING`, `SUCCEEDED`, `FAILED`, `AUTHORIZED` or `CANCELED`                      |
| `reference`   | Exact match on the merchant's reference                                           |
| `createdFrom` | ISO 8601; payments created at or after this time                                  |
| `createdTo`   | ISO 8601; payments created before this time                                       |
| `limit`       | `1` to `100`, default `20`                                                        |
| `cursor`      | The previous page's `nextCursor`; send it with the same filters for the next page |

Payments are ordered by creation time, then ID, newest first. The cursor marks the last payment
returned, so payments created while you page appear on a fresh listing, not between pages, and no
payment is skipped or repeated. `nextCursor` is `null` on the last page. Cursors are opaque; a
malformed one, an unknown parameter or a repeated one is a `400` with field `details`.

**Retries.** Only a `FAILED` payment with no attempt in flight and fewer than 3 attempts can be
retried. Otherwise the retry is refused with `409` and one of the reasons `payment_not_failed`,
`attempt_in_progress`, `failure_not_retryable` or `attempt_limit_reached`. A `PENDING` payment is
still being processed or reconciled and cannot be retried into a second charge.

## Manual capture

Created with `"captureMethod": "MANUAL"`, a payment is only **authorized**: the provider holds the
funds, and the payment becomes `AUTHORIZED` instead of `SUCCEEDED`. The merchant then either
captures it or voids it.

| Method and path                 | Body                 | Result once processed                                     |
| ------------------------------- | -------------------- | --------------------------------------------------------- |
| `POST /v1/payments/:id/capture` | `{"amount": 400000}` | `SUCCEEDED`, `amountCaptured` = the amount; rest released |
| `POST /v1/payments/:id/capture` | `{}`                 | `SUCCEEDED`, the whole authorization captured             |
| `POST /v1/payments/:id/void`    | none                 | `CANCELED`, the authorization released                    |

- Both require an `Idempotency-Key`, return `202` with the payment (still `AUTHORIZED`) and the new
  action `PENDING` in its `actions`, and are processed asynchronously like payments: marked
  submitted before the provider is called, looked up when the answer is lost, and resubmitted under
  the same action ID only if the provider has no record of it.
- **Once.** An authorization is captured or voided once, and only one capture or void can be in
  flight at a time. A **declined** or **unavailable** action (`FAILED`, with `failureCode`) leaves
  the payment `AUTHORIZED`, so it can be captured or voided again with a new key.
- **Refused** with `409` and a reason: `payment_not_authorized` (an automatic payment, or one not
  `AUTHORIZED` now), `action_in_progress`, or `amount_exceeds_authorized`.
- **Refunds** apply to the captured amount only: a payment captured for 400000 can be refunded up
  to 400000, and an `AUTHORIZED` or `CANCELED` payment cannot be refunded (void it instead).
- `actions` on the payment lists every capture and void: `id`, `type` (`CAPTURE` or `VOID`),
  `amount` (captures only), `status`, `providerReference`, `failureCode`, `createdAt`,
  `completedAt`.
- A declined authorization is `FAILED` and can be retried; the new attempt is also manual.
- Authorizations do not expire in the simulator; a real provider's would.

## Refunds

| Method and path                 | Description                                                              |
| ------------------------------- | ------------------------------------------------------------------------ |
| `POST /v1/payments/:id/refunds` | Refund all or part of a `SUCCEEDED` payment. Requires `Idempotency-Key`. |
| `GET /v1/payments/:id/refunds`  | The payment's refunds, oldest first. 404 for anyone else's payment.      |
| `GET /v1/refunds/:id`           | A refund owned by the caller. 404 for anyone else's or none.             |

Like payments, refunds are asynchronous: the `POST` returns `202 Accepted` with the refund
`PENDING`, and a worker submits it to the provider against the payment's succeeded attempt. Its
outcome appears on `GET /v1/refunds/:id`. A refund whose answer was lost stays `PENDING` until a
provider lookup establishes it; it is submitted again (under the same refund ID, the provider's
idempotency key) only if the provider has no record of it.

Request body, all optional. The currency is always the payment's and is not accepted:

| Field       | Type    | Rules                                                                                    |
| ----------- | ------- | ---------------------------------------------------------------------------------------- |
| `amount`    | integer | Minor units, `1` to `1000000000000`. Omitted: everything still refundable.               |
| `reference` | string  | 1-64 of `A-Z a-z 0-9 . _ : / # -`. Your own label; not unique, not used for idempotency. |

```json
{
  "id": "01a17c2e-4b10-7a3d-9e61-5d0c8f2b7a14",
  "paymentId": "01a16b6d-bf6d-765f-98fb-39c95d75fe23",
  "amount": 150000,
  "currency": "NGN",
  "status": "SUCCEEDED",
  "reference": "return_552",
  "providerReference": "simrf_4d2a9c0e7b1f3a5c8e6d0b2f",
  "failureCode": null,
  "createdAt": "2026-11-16T10:00:00.000Z",
  "completedAt": "2026-11-16T10:00:01.004Z"
}
```

- **Limit.** Pending and succeeded refunds together never exceed the payment's amount. A database
  trigger enforces it even under concurrent requests, so two refunds racing for the same remainder
  cannot both be accepted.
- **Statuses.** `PENDING`, `SUCCEEDED` or `FAILED`. A failed refund carries `failureCode`
  `DECLINED` or `PROVIDER_UNAVAILABLE`; it returned nothing and frees its amount for a new refund.
  A failed refund is not retried: create a new one with a new key.
- **Refused refunds** answer `409` with one of the reasons `payment_not_succeeded`,
  `nothing_left_to_refund` or `amount_exceeds_refundable`. Nothing is created.

| Status | When                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------- |
| `202`  | Refund created and queued, `PENDING`.                                                              |
| `200`  | Replay of an earlier request with the same key; header `Idempotent-Replayed: true`. Current state. |
| `400`  | Invalid body or `Idempotency-Key` (field-level `details`), bad payment id.                         |
| `404`  | Payment (or refund) does not exist or belongs to another merchant.                                 |
| `409`  | `Idempotency-Key` already used with a different request, or the refund is refused (above).         |
| `429`  | Rate limit exceeded; refunds share the per-merchant limit with payment creations and retries.      |

## Idempotency

Every `POST` that creates something needs an `Idempotency-Key` header: 1-255 visible ASCII
characters, unique per operation you intend to perform (a UUID is ideal). Creation, retry and
refund keys are separate namespaces, so reusing a value across them never makes a request
ambiguous.

| Operation      | Stored in                                            | Unique per | Same request means                     |
| -------------- | ---------------------------------------------------- | ---------- | -------------------------------------- |
| Create         | `payments.idempotency_key`                           | merchant   | same `amount`, `currency`, `reference` |
| Retry          | `payment_retry_requests` (one row per retry attempt) | merchant   | same payment ID                        |
| Refund         | `refunds.idempotency_key`                            | merchant   | same payment ID, `amount`, `reference` |
| Capture / void | `payment_actions.idempotency_key`                    | merchant   | same payment ID, action, `amount`      |

- **Same key, same request:** `200` with `Idempotent-Replayed: true` and the payment's **current**
  state, which may have moved on since the first response (e.g. `PENDING` → `SUCCEEDED`). No
  payment, attempt or job is created and nothing more is queued for the provider.
- **Same key, different request:** `409 Conflict`. Requests are compared by a SHA-256 fingerprint
  of a versioned canonical form built from the validated input:
  `["payments.create.v1", amount, currency, reference ?? null]` (with manual capture,
  `["payments.create.v2", amount, currency, reference ?? null, "MANUAL"]`),
  `["payments.retry.v1", paymentId]`, `["payments.action.v1", paymentId, type, amount ?? null]` or
  `["refunds.create.v1", paymentId, amount ?? null, reference ?? null]` (so a full refund, with no
  amount, is a different request from any explicit amount). JSON key order and whitespace do not
  matter.
- **Concurrency:** unique constraints on `(merchant_id, idempotency_key)` decide races. Concurrent
  creations with one key race on the insert; the losers hit the constraint and are answered from
  the winner's row. Retries and refunds additionally lock the payment row
  (`SELECT ... FOR UPDATE`), so concurrent retries or refunds of one payment run one at a time:
  with the same key the later ones replay, with different keys they see the effect of the earlier
  ones (a payment no longer `FAILED`, less left to refund) and may get `409`.
- **Retention:** keys never expire.

## Currencies and amounts

Amounts are integers in the currency's **minor unit**, stored as `BIGINT`, never floating point.
The number of decimals differs by currency, so never convert by assuming two decimals:

| Currency                          | Minor-unit digits | `amount: 1500` means |
| --------------------------------- | ----------------- | -------------------- |
| NGN, GHS, KES, ZAR, USD, EUR, GBP | 2                 | 15.00                |
| JPY                               | 0                 | 1500                 |
| KWD                               | 3                 | 1.500                |

The list lives in `src/payments/currencies.ts`. The maximum amount (10^12 minor units) keeps values
exact in JSON numbers.

## Merchant webhooks

PayGuard notifies a merchant of every payment and refund outcome by POSTing a signed event to the
merchant's own endpoint, so merchants need not poll. Requires `MERCHANT_WEBHOOK_ENCRYPTION_KEY`
on the server; without it the endpoint routes below that store a secret answer `503`.

| Method and path                           | Description                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `GET /v1/webhook-endpoint`                | The merchant's endpoint, without its secret. 404 when none is configured |
| `PUT /v1/webhook-endpoint`                | Create it (`201`, with the secret) or update it (`200`, without)         |
| `POST /v1/webhook-endpoint/rotate-secret` | Replace the secret; returns the new one                                  |
| `GET /v1/events`                          | The merchant's events, newest first, with their delivery state           |
| `GET /v1/events/:id`                      | One event                                                                |
| `POST /v1/events/:id/redeliver`           | Queue an event for delivery again (`202`)                                |

**Endpoint.** One per merchant. Body `{"url": "https://...", "enabled": true}`; `enabled` is
optional. The URL must be `https`, without credentials or fragment, and must not point to a
private, loopback, link-local or other non-public address; this is checked again, against every
address the host resolves to, each time a delivery connects. Redirects are not followed.
(`MERCHANT_WEBHOOK_ALLOW_PRIVATE_TARGETS=true` lifts these address rules for local testing.)
`enabled: false` stops new deliveries; events are still recorded.

**Secret.** `whsec_` followed by 43 characters, returned only by the create and by
`rotate-secret`; PayGuard stores it encrypted and never shows it again. A repeated create (for
example after a lost response) is an update and returns no secret: rotate to get one. After a
rotation, deliveries are signed with both the new and the previous secret for 24 hours, so you can
deploy the new secret without rejecting deliveries meanwhile.

**Events.** `payment.succeeded`, `payment.failed`, `refund.succeeded` and `refund.failed`, and
for manual capture `payment.authorized`, `payment.canceled` (voided), `payment.capture_failed` and
`payment.void_failed` (the provider refused it; the payment stays `AUTHORIZED`). A capture's
success is `payment.succeeded`. Each is recorded in the same transaction as the outcome. A
delivery's body is the event:

```json
{
  "id": "01a19d40-5e2b-7c1a-9f3e-2b8d4c6a0e17",
  "type": "payment.succeeded",
  "createdAt": "2026-11-17T09:30:01.204Z",
  "data": {
    "id": "01a16b6d-...",
    "amount": 500000,
    "status": "SUCCEEDED",
    "...": "..."
  }
}
```

`data` is the payment (or refund) exactly as `GET /v1/payments/:id` (or `GET /v1/refunds/:id`)
returned it when the event happened. Headers: `PayGuard-Event-Id`, `PayGuard-Event-Type`, and
`PayGuard-Signature`.

**Verifying a delivery.** `PayGuard-Signature` is `t=<unix seconds>,v1=<hex>`, with a second
`v1=` during a rotation. Each `v1` is the HMAC-SHA256, keyed with a secret, of `<t>.` followed by
the raw request body. Accept the delivery if any `v1` matches your secret (compare in constant
time) and `t` is within a few minutes of your clock. Verify the raw bytes before parsing JSON.

```js
const [t, ...signatures] = header.split(',');
const timestamp = Number(t.slice(2));
const expected = createHmac('sha256', secret)
  .update(`${timestamp}.`)
  .update(rawBody)
  .digest();
const valid =
  Math.abs(Date.now() / 1000 - timestamp) < 300 &&
  signatures.some(
    (s) =>
      /^v1=[0-9a-f]{64}$/.test(s) &&
      timingSafeEqual(Buffer.from(s.slice(3), 'hex'), expected),
  );
```

**Delivery.** A `2xx` answer within 10 seconds counts as delivered; anything else is retried after
30 s, doubling to at most an hour, for `OUTBOX_MAX_RUNS` attempts in all (10 by default, about
three hours), after which the event's delivery is `FAILED`. Deliveries are **at least once** and
**unordered**: the same event may arrive twice (deduplicate by `id`), and a later event may arrive
before an earlier one (use `createdAt` and the object's own status). An event recorded while no
endpoint was enabled has delivery status `null` and is not sent unless you redeliver it.

**Delivery state** on every event: `status` (`PENDING`, `DELIVERED`, `FAILED` or `null`),
`attempts`, `lastAttemptAt`, `lastResponseStatus`, `lastError` (`TIMEOUT`, `CONNECTION_FAILED`,
`HTTP_STATUS`, `TARGET_BLOCKED`, `ENDPOINT_DISABLED`) and `deliveredAt`. Response bodies are never
stored.

**Listing and redelivery.** `GET /v1/events` takes `type`, `paymentId`, `limit` (1-100, default 20)
and `cursor`, paginated like `GET /v1/payments`. `POST /v1/events/:id/redeliver` sends the event
again, under the same `id`, to the endpoint as configured now, with a fresh retry budget; one
already queued is left as it is. It answers `409` when no endpoint is enabled, and counts toward
the per-merchant rate limit.

## Provider webhooks

Only the simulator's endpoint exists. How stored events are applied is described in
[architecture.md](architecture.md#webhook-processing).

**Request.** `POST /v1/webhooks/simulator`, `Content-Type: application/json`, at most 64 KiB, not
compressed, no API key:

```
X-Simulator-Signature: t=1792843200,v1=5f2c...e81a   (64 lowercase hex characters)
```

```json
{
  "id": "evt_9f2e4c1b7a6d3e5f8a0b2c4d",
  "type": "payment.succeeded",
  "createdAt": "2026-10-25T12:00:00.000Z",
  "data": {
    "attemptId": "01a16b6d-bf72-73ea-83b1-f39d1c06083f",
    "providerReference": "sim_7b4affd0040515a3582e3ba9",
    "amount": 500000,
    "currency": "NGN"
  }
}
```

| Field                     | Meaning                                                                                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | The provider's stable event ID (`evt_` + 8-64 letters or digits); the same on every redelivery                                                                                                                                                                             |
| `type`                    | `payment.succeeded`, `payment.authorized` (manual capture), `payment.declined` or `payment.processing` (informational only). A charge reported for a manual-capture attempt, or an authorization for an automatic one, is recorded as `DATA_MISMATCH` and left to a lookup |
| `createdAt`               | When the provider created the event (ISO 8601, UTC)                                                                                                                                                                                                                        |
| `data.attemptId`          | The idempotency reference PayGuard sent with the submission, i.e. the attempt ID                                                                                                                                                                                           |
| `data.providerReference`  | The provider's own reference for the attempt                                                                                                                                                                                                                               |
| `data.amount`, `currency` | What the provider charged; compared with the payment, never used to change it                                                                                                                                                                                              |

The event carries no payment ID, merchant ID or status, and any undeclared field is rejected: the
attempt, its payment and its merchant come from PayGuard's records.

**Signature.** `v1` is the hex HMAC-SHA256, keyed with `SIMULATOR_WEBHOOK_SECRET`, of the signed
timestamp `t`, a `.`, and the raw body bytes exactly as sent. The body is read as raw bytes before
any JSON parsing, so verification never depends on how JSON is re-serialized, and only verified
bytes are parsed. The header format is checked strictly and the digests are compared in constant
time. A `t` more than `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` away from the server clock, in either
direction, is rejected, which bounds how long a captured delivery can be replayed; within that
window, replays are caught by event-ID deduplication. The secret is used for nothing else and
must not be a merchant API key. Secrets, signatures and bodies are never logged.

**Responses.** Bodies contain no payment data.

| Status | When                                                                                                  | Provider should |
| ------ | ----------------------------------------------------------------------------------------------------- | --------------- |
| `202`  | `{"status":"accepted"}`: stored, and its processing queued in the same transaction                    | stop            |
| `200`  | `{"status":"duplicate"}`: this event ID was already stored with the same content                      | stop            |
| `400`  | Signed, but not UTF-8 JSON, not an object, or not a valid event (unsupported type, extra fields, ...) | fix, not retry  |
| `401`  | Signature header missing, malformed, wrong, or its timestamp outside the tolerance                    | fix, not retry  |
| `409`  | This event ID was already stored with different content                                               | investigate     |
| `413`  | Body over 64 KiB                                                                                      | fix, not retry  |
| `415`  | Not `application/json`, or a compressed body                                                          | fix, not retry  |
| `429`  | The per-IP rate limit, which applies to this route like any other                                     | retry later     |
| `503`  | `SIMULATOR_WEBHOOK_SECRET` is not set, or the event could not be stored                               | retry later     |

**Sending simulator webhooks.** The simulator's events are deterministic: the event ID derives
from the attempt ID and event type, and the reference matches its submissions. The operator CLI
can sign and deliver one over HTTP, as the provider would. It is refused when
`NODE_ENV=production`:

```bash
npm run admin -- simulator:webhook --attempt <attempt-id> [--type payment.declined] [--url http://127.0.0.1:3000]
```

The type defaults to the configured `PAYMENT_SIMULATOR_OUTCOME`, and the event's `createdAt` to
the attempt's creation time, so running the command again, before or after the worker submits
the attempt, redelivers the same event (a duplicate). With
`PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS=true`, a webhook resolves a `PENDING` payment before its
delayed lookup runs, which then finds nothing left to do.

## Rate limiting

| Limit                                   | Key       | Default | Applies to                                                                                                                   |
| --------------------------------------- | --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_IP_PER_MINUTE`              | client IP | 300/min | every route except `/health*`, **before** API-key checks                                                                     |
| `RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE` | merchant  | 60/min  | `POST /v1/payments`, `/retry`, `/capture`, `/void`, `/refunds` and `/v1/events/:id/redeliver` combined, after authentication |

- Token buckets allow a burst up to the limit, then refill steadily. Over the limit, the response
  is `429` with `Retry-After: <seconds>` and the standard error body.
- The per-IP limit runs before authentication, so floods of invalid keys are rejected without a
  database lookup.
- A `429` is returned before any idempotency processing, so nothing is created. Retrying later
  with the same `Idempotency-Key` is safe. Replays count toward the limit.
- **IPv6 clients are grouped by /64.** A single host usually controls a whole /64, so limiting
  individual IPv6 addresses would let it rotate around the limit. IPv4 addresses (including
  IPv4-mapped IPv6) are limited individually.
- **Process-local:** counters live in each API process's memory, so `N` instances allow `N` times
  the configured limit, and a restart resets them. These limits protect one process from abuse;
  they are not a global quota. For a cluster-wide limit, enforce it at the load balancer or API
  gateway, or move the buckets to a shared store (for example a PostgreSQL table or Redis, which
  this project deliberately does not use).

How the client IP is determined behind a proxy is configured with `TRUSTED_PROXIES`; see
[configuration.md](configuration.md#client-ip-behind-a-proxy).

## Errors

Every error response has the same shape:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "details": [
    {
      "field": "amount",
      "messages": ["amount must not be less than 1"]
    }
  ],
  "path": "/v1/payments",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "requestId": "6f1c1a0e-2b9e-4c1e-9d55-0b2f3c7a9e10"
}
```

`details` appears only on validation errors. Unexpected errors become a generic 500 with the stack
trace logged server-side. Bodies the parser rejects keep their client status (`413` for over
100 KiB of JSON, `415` for unsupported encodings) with a generic message. `path` never includes
the query string. `requestId` matches the server logs.
