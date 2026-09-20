# Outbound webhooks

Signara posts a signed JSON event to a tenant-configured URL whenever a signing
request changes state. This is the integrator surface: n8n, Zapier, an internal
document system, or a customer's own endpoint can subscribe instead of polling
`GET /signatures/requests`.

Endpoints are per-tenant (`organizationId`), managed with the `webhooks.manage`
permission, and configured at runtime — no restart.

## Managing endpoints

| Method   | Route                  | Purpose                                                |
| -------- | ---------------------- | ------------------------------------------------------ |
| `POST`   | `/webhooks`            | Register an endpoint; **signing secret returned once** |
| `GET`    | `/webhooks`            | List endpoints (never returns the secret)              |
| `POST`   | `/webhooks/:id/ping`   | Send a signed `ping` to prove the URL works            |
| `DELETE` | `/webhooks/:id`        | Remove the endpoint and its delivery history           |
| `GET`    | `/webhooks/deliveries` | Recent attempts, optionally `?endpointId=`             |

```bash
curl -X POST https://api.signara.innotel.us/webhooks \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://hooks.example.com/signara","events":["request.signed","request.completed"]}'
```

`events` is omitted (or `["*"]`) to receive everything. Unknown event names are
rejected at registration rather than silently never firing.

## Events

| Event               | Emitted when                                  |
| ------------------- | --------------------------------------------- |
| `request.created`   | the request is created (may still be a draft) |
| `request.sent`      | invitations actually go out to signers        |
| `request.viewed`    | a signer opens the signing room               |
| `request.signed`    | one signer signs                              |
| `request.completed` | the last required signature lands             |
| `request.declined`  | a signer declines                             |
| `request.cancelled` | a sender cancels or voids the request         |
| `request.expired`   | the request expires un-signed                 |
| `request.reminded`  | an automatic or manual reminder is sent       |
| `ping`              | `POST /webhooks/:id/ping`                     |

Events are emitted from the same code path that writes the audit trail
(`SignatureEvent`), so the two histories cannot drift. Internal events with no
external meaning — `VOIDED`, `APPROVED`, `REJECTED`, `DOWNLOADED`,
`EMAIL_FAILED` — deliberately emit nothing rather than a near-miss event.

## Payload

```json
{
  "event": "request.signed",
  "organizationId": "org_...",
  "requestId": "req_...",
  "createdAt": "2026-09-20T12:00:00.000Z",
  "signerId": "sgn_...",
  "completed": false
}
```

The envelope fields are always present; the event's own fields (`signerId`,
`completed`, …) follow. `requestId` is included so a subscriber can fetch
`GET /signatures/requests/:id` without guessing.

## Verifying the signature

Every delivery carries:

| Header                | Value                                             |
| --------------------- | ------------------------------------------------- |
| `X-Signara-Event`     | the event name                                    |
| `X-Signara-Delivery`  | the delivery id (also the id in the delivery log) |
| `X-Signara-Signature` | `t=<unix-seconds>,v1=<hex hmac-sha256>`           |

The signed string is **`<t>.<raw request body>`**, keyed with the endpoint's
`whsec_…` secret:

```js
const { createHmac, timingSafeEqual } = require('node:crypto');

function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  // Reject replays: the timestamp is inside the signature, so an old delivery
  // cannot be re-sent with a fresh one.
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1 ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Compare with **byte length, then the bytes** — a plain `===` on hex strings
leaks timing. Always verify against the **raw** body: re-serializing the parsed
JSON changes key order and breaks the digest.

## Delivery, retries, and diagnosis

- One queue job per delivery attempt on the `webhooks` queue, with the default
  policy: **5 attempts, exponential backoff** starting at 2s.
- A **2xx** marks the delivery `DELIVERED`. Any other status, a timeout (10s by
  default), or a transport error marks it `FAILED`, stores the status or error
  message, and rethrows so the queue retries.
- A **disabled** endpoint is marked `FAILED` with `endpoint disabled` and is not
  retried — retrying it is only noise.
- Every attempt is recorded in `WebhookDelivery`, exposed by
  `GET /webhooks/deliveries`. "We never received it" is answered from that data,
  not from logs. Deleting an endpoint deletes its delivery history with it.
- Send failures never affect the signing flow: if the fan-out or the queue is
  unavailable, the event is logged and the signature is still collected.

## URL policy (SSRF)

Endpoint URLs are tenant-supplied and the API runs inside the deployment's own
network, sharing it with Redis, Postgres and the object store. A webhook that
could reach those would also _read the response body_ back through the delivery
log, so:

- **Private and loopback hosts are refused by default** — loopback, RFC1918,
  link-local, CGNAT, IPv6 ULA/link-local, `.local`/`.internal` names, and any
  **single-label name** (`signara-redis`, `subscriber`) since those only resolve
  inside this deployment.
- **`https` is required** for any non-private host.
- **Redirects are refused** (`redirect: 'error'`): a public URL could otherwise
  hand the request off to a private one that registration never saw.
- Set **`WEBHOOKS_ALLOW_PRIVATE=true`** to allow internal endpoints — intended
  for a subscriber on the same Docker network, where plain `http` is meaningful.

| Variable                 | Default | Meaning                               |
| ------------------------ | ------- | ------------------------------------- |
| `WEBHOOKS_ALLOW_PRIVATE` | `false` | Permit private/internal endpoint URLs |
| `WEBHOOKS_TIMEOUT_MS`    | `10000` | Per-attempt HTTP timeout              |
