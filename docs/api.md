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
- [Idempotency](#idempotency)
- [Currencies and amounts](#currencies-and-amounts)
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

| Method and path               | Description                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `POST /v1/payments`           | Create a payment and queue its first attempt. Requires `Idempotency-Key`.         |
| `POST /v1/payments/:id/retry` | Queue a new attempt for an eligible `FAILED` payment. Requires `Idempotency-Key`. |
| `GET /v1/payments/:id`        | A payment owned by the caller, with its attempts. 404 for anyone else's or none.  |

Processing is asynchronous: both `POST` operations return `202 Accepted` with the payment
`PENDING`, and the outcome appears on `GET /v1/payments/:id` once a worker has processed it
(normally within about a second). An outcome the provider did not confirm keeps the payment
`PENDING` until reconciliation establishes it.

Request body. Only these fields are accepted; anything else, such as `merchantId`, `status` or
provider data, is rejected with 400:

| Field       | Type    | Rules                                                                                              |
| ----------- | ------- | -------------------------------------------------------------------------------------------------- |
| `amount`    | integer | Minor units, `1` to `1000000000000`. JSON numbers only, never strings or decimals.                 |
| `currency`  | string  | One of the [supported ISO 4217 codes](#currencies-and-amounts), uppercase.                         |
| `reference` | string  | Optional, 1-64 of `A-Z a-z 0-9 . _ : / # -`. Your own label; not unique, not used for idempotency. |

A processed payment, as returned by `GET` (a new payment looks the same with `status: "PENDING"`
and one `PENDING` attempt without a reference):

```json
{
  "id": "01a16b6d-bf6d-765f-98fb-39c95d75fe23",
  "amount": 500000,
  "currency": "NGN",
  "status": "SUCCEEDED",
  "reference": "order_10042",
  "failureCode": null,
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

**Statuses.** Payments and attempts are `PENDING`, `SUCCEEDED` or `FAILED`; see
[the lifecycle](architecture.md#payment-lifecycle). A failed payment carries `failureCode`
`DECLINED` (the provider refused the payment) or `PROVIDER_UNAVAILABLE` (nothing was attempted).

**Retries.** Only a `FAILED` payment with no attempt in flight and fewer than 3 attempts can be
retried. Otherwise the retry is refused with `409` and one of the reasons `payment_not_failed`,
`attempt_in_progress`, `failure_not_retryable` or `attempt_limit_reached`. A `PENDING` payment is
still being processed or reconciled and cannot be retried into a second charge.

## Idempotency

Both `POST` operations need an `Idempotency-Key` header: 1-255 visible ASCII characters, unique per
operation you intend to perform (a UUID is ideal). Creation keys and retry keys are separate
namespaces, so reusing a value across the two never makes either request ambiguous.

| Operation | Stored in                                            | Unique per | Same request means                     |
| --------- | ---------------------------------------------------- | ---------- | -------------------------------------- |
| Create    | `payments.idempotency_key`                           | merchant   | same `amount`, `currency`, `reference` |
| Retry     | `payment_retry_requests` (one row per retry attempt) | merchant   | same payment ID                        |

- **Same key, same request:** `200` with `Idempotent-Replayed: true` and the payment's **current**
  state, which may have moved on since the first response (e.g. `PENDING` → `SUCCEEDED`). No
  payment, attempt or job is created and nothing more is queued for the provider.
- **Same key, different request:** `409 Conflict`. Requests are compared by a SHA-256 fingerprint
  of a versioned canonical form built from the validated input:
  `["payments.create.v1", amount, currency, reference ?? null]` or
  `["payments.retry.v1", paymentId]`. JSON key order and whitespace do not matter.
- **Concurrency:** unique constraints on `(merchant_id, idempotency_key)` decide races. Concurrent
  creations with one key race on the insert; the losers hit the constraint and are answered from
  the winner's row. Retries additionally lock the payment row (`SELECT ... FOR UPDATE`), so
  concurrent retries of one payment run one at a time: with the same key the later ones replay,
  with different keys they find the payment no longer `FAILED` and get `409`.
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

| Field                     | Meaning                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `id`                      | The provider's stable event ID (`evt_` + 8-64 letters or digits); the same on every redelivery |
| `type`                    | `payment.succeeded`, `payment.declined` or `payment.processing` (informational only)           |
| `createdAt`               | When the provider created the event (ISO 8601, UTC)                                            |
| `data.attemptId`          | The idempotency reference PayGuard sent with the submission, i.e. the attempt ID               |
| `data.providerReference`  | The provider's own reference for the attempt                                                   |
| `data.amount`, `currency` | What the provider charged; compared with the payment, never used to change it                  |

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

| Limit                                   | Key       | Default | Applies to                                                      |
| --------------------------------------- | --------- | ------- | --------------------------------------------------------------- |
| `RATE_LIMIT_IP_PER_MINUTE`              | client IP | 300/min | every route except `/health*`, **before** API-key checks        |
| `RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE` | merchant  | 60/min  | `POST /v1/payments` and `/retry` combined, after authentication |

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
