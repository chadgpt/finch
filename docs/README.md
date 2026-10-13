# Finch Agent Integration Documentation

Provider guide for publishing and operating a hosted Agent in Finch Agent Market.

> English-first reference. Generated from the same structured source rendered in Finch.

## Overview and minimum implementation

Finch lets a provider publish a hosted Agent as a versioned Agent Market service. You operate the runtime, model, tools, and data. Finch owns the user Session, market listing, service version, Offer, Call Rights, logical invocation, Artifact authority, contract test, and review lifecycle.

> **Finch account model:** Configure the integration from the signed-in Provider workspace. Finch does not issue legacy merchant API keys. When agenton_v0 is selected, Finch projects compatibility order and commercial fields from persisted Finch authority; those fields do not replace Call Rights or grant authority by themselves.

| To submit a version | Minimum requirement |
| --- | --- |
| Market profile | English display name, description, and support contact for the initial Agent draft; required MP4/WebM avatar video for both hosted Agent and Direct API integrations |
| Runtime | Public Invoke and Health URLs plus an immutable mutual-signing credential revision for P1-P3 |
| Offer | Interaction mode, Call Rights units, quantity bounds, duration, and input-round limits |
| Evidence | A passing live contract test for the exact draft version |
| Review | All release gates complete before submission |


## Ownership boundaries

| Provider owns | Finch owns |
| --- | --- |
| Runtime availability, model behavior, tools, prompts, and provider data | Authenticated user Session and provider ownership |
| Input processing within the declared service boundary | Listing, immutable version and Offer revision selected for a call |
| Returning signed protocol-compliant results | Call Rights reservation, quantity, deadline, and invocation state |
| Uploading output bytes only to issued URLs | Artifact slots, asset IDs, validation, publication, and user retrieval |
| Operational support and incident response | Contract-test evidence, review state, and marketplace visibility |

> **Do not infer commercial authority from the request body:** Finch authorizes execution from persisted Call Rights and the exact Offer revision. Never accept price, currency, wallet, or buyer-account fields supplied by a caller as authority.


## Create the English market profile

The profile is the user-facing contract for discovery and support. Write it in English and describe outcomes, required inputs, limitations, and the boundary between Finch and your service.

| Field | Requirement |
| --- | --- |
| Display name | Required; concise Agent/Chip name for discovery |
| Description | Required; describe inputs, outputs, limits, and service behavior |
| Support contact | Required on create-agent; reachable support channel for the Provider profile |
| Avatar | Required for hosted Agent and Direct API creation and listing saves: MP4/WebM up to 20 MB, uploaded before creation. Send both avatarUri and avatarMediaType; about five seconds is guidance. Existing static avatars must be replaced on the next listing save. |

> **Versioning:** Creating the profile creates a draft service version. Runtime or Offer changes apply to that draft and invalidate stale contract-test evidence.


## Runtime endpoints

Register one immutable hosted Agent Runtime snapshot for the draft. Its integration family is stored as agenton_v2, while wireProtocol selects the actual Provider payload contract: finch_v2 or agenton_v0. New drafts default to finch_v2.

| Runtime field | Current requirement |
| --- | --- |
| wireProtocol | finch_v2 or agenton_v0; frozen with the Runtime and credential revisions |
| invocationUrl | Public HTTPS URL without embedded credentials or fragments; receives every P1/P2/P3 initial POST |
| healthUrl | Public HTTPS URL without embedded credentials or fragments; receives signed GET health probes |
| taskUrl | Public HTTPS base URL without credentials, fragments, or query parameters. It is registered for every hosted Agent Runtime and used for P2/P3 task operations. Trailing slashes are normalized. |
| timeoutSeconds | Integer from 1 through 120, applied to Provider calls |
| credentialSetupId | Finch credential setup whose exact Request and Callback credential revisions are frozen into the Runtime snapshot |

| Operation | Method and target | Required HTTP response | Finch transport retry |
| --- | --- | --- | --- |
| Health | GET healthUrl with empty body | 200 with signed JSON status ready or ok | Contract test performs the signed readiness probe; Provider handling must be idempotent |
| P1 conversation | POST invocationUrl | 200 with completed, input_required, or failed | Each transport attempt is retry-none. Normal execution may claim one controlled retry, for at most 2 attempts total; contract-test invocation sends once. |
| P2/P3 initial dispatch | POST invocationUrl | 202 with accepted and merchant_task_id | Safe transient retry, at most 2 attempts |
| P2/P3 poll | GET taskUrl/{encoded merchant_task_id} with empty body | 200 with one task snapshot | Safe transient retry, at most 3 attempts with 100 ms delay |
| Supplemental input | POST taskUrl/{encoded merchant_task_id}/messages | 200 or 202 with accepted | None |
| Cancel | POST taskUrl/{encoded merchant_task_id}/cancel | 200 or 202 with accepted or canceled | None |
| Callback | Provider POSTs to callback.url from the original request | Finch authenticates and deduplicates the event | Provider-owned delivery policy; event_id and sequence make replay safe |

Header sets are operation-specific. P1 sends Content-Type: application/json and Idempotency-Key. P2/P3 dispatch, poll, supplemental input, and cancel send Accept: application/json and Idempotency-Key, plus Content-Type: application/json on POST. Signed health currently sends only the X-Platform-* HMAC headers. Every synchronous Provider response must carry valid X-Agent-* HMAC headers: Finch authenticates the exact response bytes even when the HTTP status is not successful, before interpreting the status or JSON body.

**Signed contract-test health probe and response**

```http
GET /health HTTP/1.1
X-Platform-Key-Id: <key-id>
X-Platform-Timestamp: <epoch-seconds>
X-Platform-Nonce: <nonce>
X-Platform-Signature: v1=<hex-hmac>

HTTP/1.1 200 OK
Content-Type: application/json
X-Agent-Key-Id: <same-key-id>
X-Agent-Timestamp: <epoch-seconds>
X-Agent-Nonce: <new-provider-nonce>
X-Agent-Signature: v1=<hex-hmac>

{"status":"ready"}
```

> **Health has no request body:** Canonicalize the health request as GET with SHA256(empty bytes). Do not send or expect a JSON probe body, and do not canonicalize this request as POST. The signed response body is the exact UTF-8 JSON bytes returned by the Provider.

> **Deployment gate:** Production invocation routes remain unavailable until Finch has injected every protected runtime, credential, nonce, and Artifact capability required by that mode. Missing protected configuration fails closed.


## Finch v2, legacy signed protocol, and Direct API

The persisted hosted Agent integration family is named agenton_v2. Inside that family, the Runtime selects one of two explicit Provider wire protocols. They share paths and signed HTTP transport, but their JSON identities and key-ID formats differ. Direct API is a separate integration family.

> **Existing hosted Agent migration:** Choose agenton_v0 and keep the existing invocation, task, and health URLs, API key ID, Request secret, and Callback secret unchanged. Existing agenton_v0 responses may continue omitting protocol_version; when present it must still equal 2.0. Finch keeps every other response identity strict.

| Configured protocol | Transport authentication | Wire identity and payload |
| --- | --- | --- |
| Finch Agent protocol v2 (finch_v2) | Mutual HMAC using Base64URL-decoded Request and Callback secrets | Requires protocol_version: 2.0 and Finch version, dispatch, Offer, hash, callback, limits, and mode fields. New drafts default here. Key IDs use finch.agenton.<uuid>. |
| Legacy signed protocol (agenton_v0) | The same mutual HMAC algorithm and headers, using the displayed secret text directly as UTF-8 bytes | Requests require protocol_version: 2.0; responses may omit it but must use exactly 2.0 when present. Preserves the legacy order, agent, commercial, subject, callback, limits, and mode envelope. Key IDs use the 20-character eav_<16 hex> form. |
| Direct API (direct_api_v1 / P4) | None, Bearer, or one configured request header | No signed Agent envelope, no X-Platform/X-Agent headers, no Request/Callback secret pair. Input and output follow the frozen Direct API schemas. |

> **No protocol fallback:** Implement the protocol selected on the saved Runtime exactly. Do not detect or translate a request by trying Finch v2 and then legacy signed protocol, and do not infer the protocol from the key ID alone.

| Identity rule | finch_v2 | agenton_v0 |
| --- | --- | --- |
| Request protocol_version | Required and exactly 2.0 | Required and exactly 2.0 |
| Request invocation_id | Canonical UUID | ivk_ followed by 32 lowercase hex characters |
| P1 response invocation_id | Required and must match | Required and must match |
| Async accepted invocation_id | Required and must match | Required and must match |
| Poll merchant_task_id | Required and must match the targeted task | Required and must match the targeted task |
| Callback invocation_id | Optional; if present it must match | Optional; if present it must match |
| Key ID | finch.agenton.<uuid> | eav_<16 lowercase hex>, exactly 20 characters |

**finch_v2 common request example**

```json
{
  "protocol_version": "2.0",
  "invocation_id": "<uuid>",
  "dispatch_id": "<uuid>",
  "service_version_id": "<uuid>",
  "offer_id": "<uuid>",
  "offer_revision": 3,
  "interaction_mode": "task",
  "quantity": 1,
  "terms_hash": "0x<32-byte hex>",
  "request_hash": "0x<32-byte hex>",
  "callback": {
    "url": "https://finch.example/callbacks/<opaque>",
    "callback_key_id": "finch.agenton.<uuid>"
  },
  "limits": {
    "deadline_at": "2026-08-30T11:00:00.000Z"
  }
}
```

**agenton_v0 contract-test request example**

```json
{
  "protocol_version": "2.0",
  "invocation_id": "ivk_<32 lowercase hex>",
  "contract_test": true,
  "order": {
    "order_id": "<uuid>",
    "billable_entity_type": "task",
    "billable_entity_id": "<Finch-task-uuid>"
  },
  "agent": {
    "agent_id": "<uuid>",
    "version": "1",
    "offer_id": "<uuid>",
    "interaction_mode": "task"
  },
  "commercial": {
    "pricing_version": 1,
    "model": "per_completed_task",
    "currency": "USDC",
    "unit": "completed_task",
    "unit_price_micro_usdc": 0,
    "quantity": 1,
    "authorized_amount_micro_usdc": 0
  },
  "subject": {
    "user_id": "usr_<16 lowercase hex>",
    "locale": "zh-CN"
  },
  "callback": {
    "url": "https://finch.example/callbacks/<opaque>",
    "callback_key_id": "eav_<16 lowercase hex>"
  },
  "limits": {
    "deadline_at": "2026-08-30T11:00:00.000Z"
  }
}
```

> **Legacy commercial values:** agenton_v0 serializes commercial integer fields as JSON numbers, derived strictly from persisted decimal strings. During contract tests, unit_price_micro_usdc and authorized_amount_micro_usdc are both 0. The current compatibility subject is usr_<16 lowercase hex> with locale zh-CN. For an async task, order.billable_entity_id is the Finch task UUID and is also the task_id in each supplemental-input body; it is not the Provider-generated merchant_task_id.


## Mutual HMAC signing

Both finch_v2 and agenton_v0 sign the exact raw HTTP body with HMAC-SHA256. Verify the signature before decoding JSON. Preserve the exact request method and path including the query string.

> **Secret encoding follows wireProtocol:** For finch_v2, Base64URL-decode each displayed 43-character secret to exactly 32 raw bytes. For agenton_v0, preserve legacy signing behavior and use the displayed 43-character Request or Callback secret directly as UTF-8 bytes. Decoding an agenton_v0 secret changes the HMAC key.

**Canonical string**

```text
METHOD
PATH_WITH_QUERY
TIMESTAMP
NONCE
SHA256(raw_body)
```

**Signature value**

```text
v1=<lowercase hex HMAC-SHA256(canonical_string, secret)>
```

| Message | Headers | Decoded HMAC key |
| --- | --- | --- |
| Finch request to Provider: health, invoke, poll, supplemental input, cancel | X-Platform-Key-Id, X-Platform-Timestamp, X-Platform-Nonce, X-Platform-Signature | Request secret |
| Provider synchronous response to Finch: health, invoke, poll, supplemental input, cancel | X-Agent-Key-Id, X-Agent-Timestamp, X-Agent-Nonce, X-Agent-Signature | Request secret |
| Provider asynchronous callback to callback.url | X-Agent-Key-Id, X-Agent-Timestamp, X-Agent-Nonce, X-Agent-Signature | Callback secret |

- Allow at most 300 seconds of clock skew and keep hosts time-synchronized.
- Persist consumed nonces durably and reject replay across processes and restarts.
- Bind verification to the immutable service-version credential revision and expected key ID.
- For a signed synchronous response, canonicalize with the original request method and path; hash the exact response body bytes.
- For a callback, canonicalize POST and the callback URL path including its query string; hash the exact callback body bytes.
- Sign response and callback bytes exactly as sent; serialization after signing invalidates the signature.
- Rotate credentials by creating a new revision. Do not mutate a credential used by an in-flight dispatch.

**TypeScript protocol-specific secret bytes**

```typescript
const secretBytes = wireProtocol === 'agenton_v0'
  ? Buffer.from(displayedSecret, 'utf8')
  : Buffer.from(displayedSecret, 'base64url');
if (wireProtocol === 'finch_v2' &&
    (secretBytes.length !== 32 || secretBytes.toString('base64url') !== displayedSecret)) {
  throw new Error('Invalid Finch signing secret');
}
```

**Python protocol-specific secret bytes**

```python
import base64

def finch_secret_bytes(displayed_secret: str, wire_protocol: str) -> bytes:
    if wire_protocol == 'agenton_v0':
        return displayed_secret.encode('utf-8')
    padding = '=' * (-len(displayed_secret) % 4)
    secret_bytes = base64.urlsafe_b64decode(displayed_secret + padding)
    if len(secret_bytes) != 32:
        raise ValueError('Invalid Finch signing secret')
    return secret_bytes
```


## Finch v2 common envelope

For finch_v2, Finch composes common fields from the persisted logical invocation, exact dispatch, historical Offer/version revision, and dispatch-time callback credential snapshot. Mode-specific P1, P2, or P3 fields are merged at the root. agenton_v0 uses the compatibility envelope shown above but merges the same mode fragments.

**Common request fields**

```json
{
  "protocol_version": "2.0",
  "invocation_id": "<uuid>",
  "dispatch_id": "<uuid>",
  "service_version_id": "<uuid>",
  "offer_id": "<uuid>",
  "offer_revision": 3,
  "interaction_mode": "conversation_turn",
  "quantity": 1,
  "terms_hash": "0x<32-byte hex>",
  "request_hash": "0x<32-byte hex>",
  "limits": {
    "deadline_at": "2026-08-24T10:30:00.000Z"
  },
  "callback": {
    "url": "https://finch.example/callbacks/<opaque>",
    "callback_key_id": "finch.agenton.<uuid>"
  }
}
```

> **Removed legacy fields:** Do not require or return currency, unit, unit_price, authorized_amount, raw buyer account ID, locale, or model as common envelope fields. P4 Direct API is outside this envelope.


## Synchronous conversation turns

P1 sends platform-managed conversation context plus the current input to invocationUrl with POST. Finch accepts only HTTP 200. Each Provider transport attempt is retry-none; normal execution may claim one controlled retry under the policy below, while contract-test P1 sends once. Reply synchronously with completed, input_required, or failed. finch_v2 responses require protocol_version: 2.0; agenton_v0 responses may omit it but must use exactly 2.0 when present. Both require a response invocation_id matching the request.

**P1 mode fields inside the request**

```json
{
  "conversation": {
    "conversation_id": "<uuid>",
    "turn_id": "<uuid>",
    "context_mode": "platform_managed",
    "messages": [
      {
        "message_id": "<uuid>",
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "Summarize this report."
          }
        ]
      }
    ]
  },
  "input": {
    "content": [
      {
        "type": "text",
        "text": "Summarize this report."
      }
    ],
    "parameters": {}
  },
  "task_completed": false,
  "output_contract": {
    "artifacts": {
      "min_items": 0,
      "max_items": 1,
      "allowed_media_types": [
        "application/pdf"
      ],
      "max_bytes_per_asset": 5242880,
      "max_total_bytes": 5242880
    }
  },
  "artifact_uploads": []
}
```

**Completed response**

```json
{
  "protocol_version": "2.0",
  "invocation_id": "<uuid>",
  "status": "completed",
  "message": {
    "role": "agent",
    "content": [
      {
        "type": "text",
        "text": "The report identifies three main risks."
      }
    ]
  },
  "artifacts": [],
  "completed_at": "2026-08-24T10:29:12.000Z"
}
```

**Input-required response**

```json
{
  "protocol_version": "2.0",
  "invocation_id": "<uuid>",
  "status": "input_required",
  "questions": [
    {
      "id": "scope",
      "question": "Which reporting period should I use?"
    }
  ]
}
```

**Legacy agenton_v0 completed response**

```json
{
  "protocol_version": "2.0",
  "invocation_id": "ivk_<32 lowercase hex>",
  "status": "completed",
  "message": {
    "role": "agent",
    "content": [
      {
        "type": "text",
        "text": "The report identifies three main risks."
      }
    ]
  },
  "artifacts": [],
  "completed_at": "2026-08-30T10:59:12.000Z"
}
```

For completed output, message.role must be agent. Content can contain text, JSON, or Finch-issued Artifact references. For failed output, return error.code and an optional safe error.message.


## Publish the buyer chat composer, not a JSON form

New P1, P2, and P3 Offers start with the recommended text input and output contracts already filled in under the collapsed Advanced section. Most Providers should leave those defaults unchanged. The buyer workspace renders the Offer input schema in one of three ways. The chat composer renders only when the input schema is the hosted Agent composer contract below. Any other object schema renders typed form fields, and a contract that cannot map to fields falls back to advanced JSON entry.

**Default Offer input schema (exactly one required content property)**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": true,
  "required": [
    "content"
  ],
  "properties": {
    "content": {
      "type": "array",
      "minItems": 1,
      "maxItems": 100,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "type",
              "text"
            ],
            "properties": {
              "type": {
                "const": "text"
              },
              "text": {
                "type": "string",
                "minLength": 1,
                "maxLength": 10000
              }
            }
          }
        ]
      }
    }
  }
}
```

**Default Offer output schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "message": {
      "type": "object",
      "properties": {
        "content": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      },
      "additionalProperties": true
    },
    "result": {},
    "artifacts": {
      "type": "array",
      "items": {
        "type": "object"
      }
    },
    "modalities": {
      "const": [
        "text"
      ]
    }
  },
  "additionalProperties": true
}
```

**Default connection-test validation input**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Describe your capabilities."
    }
  ]
}
```

- The root must be an object whose properties contain exactly one entry, content, and required must be exactly ["content"].
- content.items must be an array item schema whose oneOf (or anyOf) union includes a text variant: type const "text" plus a 1..10000 character text string.
- The same union may declare image, video, and file variants. The default contract publishes text while Finch retains the existing verified-file compatibility composer for hosted Agent Offers.
- Migrated agenton_v0 Offers additionally carry an x-finch-input-artifacts keyword (maxAssets, maxBytesPerAsset, maxTotalBytes). The Merchant Offer API compiles input schemas with Ajv in strict mode and rejects that non-standard keyword; omit it and Finch applies the default attachment policy (4 assets per turn within the platform byte bounds).
- A content array whose items are a single object (no oneOf union) is NOT the composer contract: the buyer sees a JSON field instead of the chat box.
- The old root oneOf of string or content-object is recognized only so migrated published Offers remain usable. Do not copy it into a new Offer; use the default object schema above.

> **Keep the wire and the schema aligned:** The platform sends input.content exactly as the buyer typed it: an array of {type: "text", text} parts for composer Offers. Your P1/P2/P3 handler must read the current turn text from input.content regardless of which input schema variant you published.


## Asynchronous task and generation

P2 Task and P3 Generation receive the same protocol-specific common envelope plus their mode fields at invocationUrl. Acknowledge the initial POST with HTTP 202 only. Generate a stable merchant_task_id, persist it before responding, and use that Provider task ID in every poll, supplemental-input, cancel, and callback target or identity field.

**Accepted response**

```json
{
  "protocol_version": "2.0",
  "invocation_id": "<uuid>",
  "status": "accepted",
  "merchant_task_id": "provider-task-123",
  "poll_after_ms": 5000
}
```

**Legacy agenton_v0 accepted response**

```json
{
  "protocol_version": "2.0",
  "invocation_id": "ivk_<32 lowercase hex>",
  "status": "accepted",
  "merchant_task_id": "provider-task-123",
  "poll_after_ms": 5000
}
```

> **Keep the two task identities separate:** Finch has a durable task identity for the admitted async run, and your runtime has its own merchant_task_id. In the initial legacy signed envelope, order.billable_entity_id is the Finch task identity. In every supplemental-input body, task_id is that same Finch task identity. The URL path for poll, supplemental input, and cancel uses your returned merchant_task_id. Never replace one with the other, and never generate a new identity between input rounds.

**Supplemental input target and body**

```http
POST /tasks/provider-task-123/messages HTTP/1.1
Accept: application/json
Content-Type: application/json
Idempotency-Key: <unique-input-key>

{
  "protocol_version": "2.0",
  "task_id": "<Finch-task-uuid>",
  "message": {
    "role": "user",
    "content": [{ "type": "text", "text": "Here is the job description..." }]
  }
}
```

| Operation | finch_v2 request body | agenton_v0 request body | Response identity |
| --- | --- | --- | --- |
| Poll GET | Empty bytes | Empty bytes | protocol_version follows the selected protocol; merchant_task_id is required and must match |
| Supplemental input POST | { protocol_version: 2.0, task_id: Finch task identity, message } | { protocol_version: 2.0, task_id: Finch task identity, message } | POST taskUrl/{merchant_task_id}/messages; 200 or 202; finch_v2 requires protocol_version: 2.0; agenton_v0 may omit it; status accepted; merchant_task_id optional but must match when present |
| Cancel POST | { protocol_version: 2.0, reason: user_requested } | { protocol_version: 2.0, reason: user_requested } | 200 or 202; finch_v2 requires protocol_version: 2.0; agenton_v0 may omit it; status accepted or canceled; merchant_task_id optional but must match when present |
| Callback POST | protocol_version: 2.0 plus event payload | protocol_version: 2.0 plus the original legacy event payload | event_id, positive sequence, and merchant_task_id required; event_type or status required |

Recognized statuses are submitted, working, queued, generating, uploading, input_required, completed, failed, canceled, and expired. poll_after_ms can be 0 through 3,600,000 milliseconds; Finch defaults to 3,000 when omitted.

> **Protocol identity:** finch_v2 requires protocol_version: 2.0 on every async response. agenton_v0 accepted, poll, callback, supplemental-input, and cancel responses may omit protocol_version; when present it must still equal 2.0. The Finch task identity and your merchant_task_id are different authorities: preserve each in the field or URL where Finch specifies it, and make every returned merchant_task_id match the targeted Provider task.


## Callbacks, polling, and progress

Callbacks are preferred for timely updates; polling is the recovery path. Events must be monotonic for a task. Use a durable event_id and strictly increasing positive sequence so Finch can make duplicate delivery idempotent. A callback must include event_type, status, or both; when both appear, task.<status> and status must agree.

**Progress callback**

```json
{
  "protocol_version": "2.0",
  "event_id": "evt-provider-task-123-4",
  "invocation_id": "<uuid>",
  "event_type": "task.generating",
  "status": "generating",
  "merchant_task_id": "provider-task-123",
  "sequence": 4,
  "progress": {
    "percent": 65,
    "stage": "Rendering final image"
  }
}
```

**Completed callback**

```json
{
  "protocol_version": "2.0",
  "event_id": "evt-provider-task-123-5",
  "event_type": "task.completed",
  "merchant_task_id": "provider-task-123",
  "sequence": 5,
  "message": {
    "role": "agent",
    "content": [
      {
        "type": "text",
        "text": "Generation complete."
      }
    ]
  },
  "artifacts": [
    {
      "slot_id": "<uuid>",
      "asset_id": "<uuid>",
      "sha256": "<64 lowercase hex>",
      "bytes": 248112,
      "filename": "result.png"
    }
  ]
}
```

> **P2 versus P3:** A P2 completion requires an Agent message. P3 may complete with Artifact output only. In both cases Artifact reports are untrusted candidates until Finch validates the issued slot and uploaded bytes.

> **Callback authentication is separate:** Sign callbacks with the protocol-specific Callback secret bytes, not the Request secret. Poll, input, cancel, and every synchronous response use the Request secret. The key ID remains the frozen Runtime key ID.


## Finch-issued Artifact upload slots

Finch allocates output assets before dispatch and sends time-limited upload capabilities. Upload bytes to put_url, obey the media and byte limits, then reference the exact slot_id and asset_id in the completed response. Arbitrary provider-hosted output URLs are not accepted as completed Artifacts.

**Artifact contract and upload capability**

```json
{
  "output_contract": {
    "artifacts": {
      "min_items": 1,
      "max_items": 1,
      "allowed_media_types": [
        "image/png"
      ],
      "max_bytes_per_asset": 5242880,
      "max_total_bytes": 5242880
    }
  },
  "artifact_uploads": [
    {
      "slot_id": "<uuid>",
      "asset_id": "<uuid>",
      "put_url": "<signed HTTPS URL>",
      "allowed_media_types": [
        "image/png"
      ],
      "max_bytes": 5242880,
      "expected_kind": "image",
      "expires_at": "2026-08-24T10:35:00.000Z"
    }
  ]
}
```

1. Choose an issued slot compatible with the output media type.
2. Upload the raw bytes to put_url before expires_at and within max_bytes.
3. Compute the SHA-256 of the uploaded bytes and retain the byte count.
4. Return the issued slot_id and asset_id in the completion report.
5. Wait for Finch validation; an upload is not published merely because storage accepted it.

> **Legacy signed upload response:** An existing agenton_v0 Agent may PUT its original Content-Type without X-Finch-Artifact-Filename. Finch returns HTTP 200 JSON with status ready, the issued asset_id, lowercase SHA-256, and byte count. finch_v2 keeps its strict text/plain, filename-header, and HTTP 204 contract.


## Direct API is a separate contract

> **No signed Agent envelope or HMAC:** P4 sends the buyer input directly under the configured Direct API contract. It does not use the P1-P3 common envelope or X-Platform / X-Agent signing headers.

| Setting | P4 requirement |
| --- | --- |
| Invocation URL | Public HTTPS endpoint that returns the buyer operation result |
| Health URL | Public HTTPS endpoint. Finch sends anonymous GET and requires exactly HTTP 200. |
| Preflight URL | Optional public HTTPS endpoint checked with the exact candidate input before Finch reserves a Call Right. |
| Method | GET or POST; applies to invocation and optional preflight |
| Schemas | JSON Schema 2020-12 input and output contracts, frozen into the Direct Version configuration hash |
| Test input | A JSON value valid against the input schema that produces a useful response |
| Credentials | None, Authorization: Bearer <token>, or one configured request header. Finch keeps it out of browser recovery and published metadata. |
| Timeout | Integer from 1 through 120 seconds |
| Retry | No automatic retry after dispatch; ambiguous delivery must not cause duplicate side effects |

| Operation | Exact Finch request | Success predicate |
| --- | --- | --- |
| Health | Anonymous GET Health URL; no body or configured credential | Exactly HTTP 200 |
| Preflight | Configured GET/POST request with exact candidate input and configured credential | 2xx JSON object containing accepted: true |
| Invocation | Configured GET/POST request with exact buyer input and configured credential | 2xx JSON response that matches the output schema and is useful |

Direct API health is always an anonymous, unsigned GET to the exact Health URL and requires HTTP 200. It does not send the configured credential and is not an signed Agent health exchange. Connection tests cap health and preflight probes at 10 seconds even when the configured timeout is higher; buyer invocation uses the full configured timeout up to 120 seconds.

**POST Direct API example**

```http
POST /v1/search HTTP/1.1
Host: api.provider.example
Accept: application/json
Content-Type: application/json
Authorization: Bearer <configured credential>

{"query":"Finch protocol","limit":5}
```

**Preflight success response**

```json
{
  "accepted": true
}
```

For GET invocation and preflight, Finch preserves query keys already present in the configured URL, then appends each non-null top-level input property. Array and object values are JSON-encoded. Finch never overwrites a pinned query key. For POST, it sends the input as JSON with Accept: application/json and Content-Type: application/json.

A successful invocation response must be non-empty JSON, be at most 65,536 bytes, and validate against the exact output schema. Finch rejects null, empty strings, empty arrays or objects, and known placeholder values such as "...", "N/A", "todo", and "placeholder" even when a schema permits them. Redirects are not accepted.

> **Schema policy:** Each schema is limited to 32 KiB; input and output payloads are limited to 64 KiB. Finch validates without coercion, defaults, or removal of extra fields. Schemas support only non-recursive local $ref: remote or recursive references, pattern-based keywords, depth over 12, and overly complex branch/property/enum shapes fail closed. Use additionalProperties: false when the contract is closed.

1. Implement and expose public HTTPS Health and Invocation endpoints; add Preflight only when the Provider has a real admission decision.
2. Configure URLs, method, timeout, JSON Schemas, test input, price, and optional credential in Create Direct API.
3. Run Full Direct connection test. Finch checks health, optional preflight, safe real invocation, schemas, credential binding, and the exact configuration hash.
4. Correct every failed check and rerun the full test after changing endpoints, schemas, timeout, or credential configuration.
5. Sign and publish, then buy a Call Right and execute one buyer call from the published service workspace.


## Errors, retries, idempotency, and replay

| Situation | Provider behavior |
| --- | --- |
| Duplicate invocation_id or dispatch_id | Return the previously persisted result or task identity; do not execute twice |
| Duplicate callback event | Reuse event_id and sequence for the same event; Finch deduplicates durably |
| Invalid signature, key ID, timestamp, or replayed nonce | Reject before JSON parsing with 401 or 403 and no side effects |
| Request contract violation | Return 400 or 422 with a stable, non-sensitive error code |
| Temporary overload before work is accepted | Return 429 or 503 and Retry-After when useful |
| Failure after an async task was accepted | Report failed through the task snapshot or signed callback |
| Signed non-success HTTP response | Still sign the exact response bytes; Finch verifies X-Agent-* before classifying the status or body |
| P4 ambiguous transport outcome | Do not rely on Finch automatically retrying the invocation |

| Finch operation | Automatic transport policy |
| --- | --- |
| P1 invocation | Per-attempt transport retry is disabled. Normal execution may make one controlled retry, at most 2 attempts total, only after a retry-eligible not-sent failure or signed HTTP 429, 502, 503, or 504. Contract-test P1 sends once. |
| P2/P3 initial dispatch | Safe transient retry only, maximum 2 attempts |
| P2/P3 poll | Safe transient retry only, maximum 3 attempts, 100 ms delay |
| Supplemental input and cancel | No automatic retry |
| Direct API invocation | No automatic retry after dispatch |

- Persist idempotency state before acknowledging accepted work.
- Never include secrets, raw credentials, private prompts, or stack traces in error messages.
- Log invocation_id, dispatch_id, merchant_task_id, credential revision, event_id, and trace ID for correlation.
- Bound request and response sizes and enforce deadlines at every downstream dependency.


## Offer, contract test, and review gates

An Offer is the purchasable execution contract. Select P1, P2, P3, or P4 and declare Call Rights units, quantity bounds, maximum duration, and input rounds. The exact Offer/version hashes are persisted into each admitted invocation.

> **Keep the default composer contract for normal text Agents:** The Creator pre-fills the recommended input schema, output schema, and validation prompt. Customize them only when the Agent genuinely requires structured fields or additional modalities. A content array without a oneOf text variant falls back to structured JSON and prevents plain-text submission.

**Required Offer input schema for the natural input box**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": true,
  "required": [
    "content"
  ],
  "properties": {
    "content": {
      "type": "array",
      "minItems": 1,
      "maxItems": 100,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "type",
              "text"
            ],
            "properties": {
              "type": {
                "const": "text"
              },
              "text": {
                "type": "string",
                "minLength": 1,
                "maxLength": 10000
              }
            }
          }
        ]
      }
    }
  }
}
```

**Recommended text output schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "message": {
      "type": "object",
      "properties": {
        "content": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      },
      "additionalProperties": true
    },
    "result": {},
    "artifacts": {
      "type": "array",
      "items": {
        "type": "object"
      }
    },
    "modalities": {
      "const": [
        "text"
      ]
    }
  },
  "additionalProperties": true
}
```

The connection-test validation input for this shape is {"content":[{"type":"text","text":"Describe your capabilities."}]}. Creator shows this as the plain prompt “Describe your capabilities.” and persists the matching content object.

1. Save the draft runtime configuration and credential revision.
2. Create at least one Offer for the intended interaction mode.
3. Deploy the exact service version to the registered endpoints.
4. Run the live contract test. Finch probes Health and Invoke behavior and stores per-check evidence.
5. Resolve every failed check, rerun the test, and confirm the evidence belongs to the current draft.
6. Submit for review only after profile, disclosure, runtime, Offer, and contract-test gates are complete.

> **Tests are version evidence:** Changing endpoints, credentials, schemas, runtime hashes, or Offer terms can make previous evidence stale. Passing an earlier version does not approve the current draft.


## Production readiness checklist

- English display name, description, and support contact accurately describe inputs, outputs, and limitations.
- Avatar is a required MP4/WebM video up to 20 MB, legible at small sizes; about five seconds is recommended.
- All configured destinations use public HTTPS and reject unsafe redirects.
- P1-P3 derive secret bytes according to wireProtocol, verify exact raw bytes, enforce 300-second skew, and durably consume nonces.
- Credential revisions can rotate without changing in-flight dispatch authority.
- P1 returns strict completed, input_required, or failed envelopes.
- Every Offer publishes either the chat-composer input contract or an intentional structured form; a content-array schema without the oneOf union is corrected before submission.
- P2/P3 persist task identity before HTTP 202 and support monotonic callbacks plus polling recovery.
- Output bytes use only Finch-issued Artifact slots and remain within the declared contract.
- P4 input and output both pass the exact JSON Schemas and the endpoint is safe without automatic retry.
- Duplicate requests and callbacks are idempotent across restarts and multiple instances.
- Health checks cover model, queue, storage, and critical tool dependencies.
- The contract test passes against the deployed draft and the review summary is correct.

> **Keep this document with the version:** Use Copy Markdown to store the complete Finch integration contract with your implementation notes and release checklist.


## Operational troubleshooting playbook

These playbacks come from real TEST bring-up incidents. They cover the failure signatures a Provider or operator actually sees, what each one means, and the verified recovery path. None of them require changing credentials, environment bindings, or published rows directly.

| Symptom | What it means | Verified recovery |
| --- | --- | --- |
| Buyer call fails fast with AGENT_MARKET_INTERNAL_ERROR; no request reaches the Provider | A deterministic runtime preparation failure was converted to a terminal failed invocation; the public error is deliberately generic | Read the runtime worker log for RUNTIME_AGENTON_P1_PREPARATION_FAILED with its bounded diagnostic code, then match the row below |
| Diagnostic runtime_authority_missing | The runtime preparation resolver returned zero rows for the invocation | Confirm the invocation revision against the published catalog revision. For migrated agenton_v0 Agents the v0 commercial authority must exist on the exact Offer revision being called; Merchant offer updates now carry it forward automatically and older revisions were backfilled |
| Diagnostic runtime_authority_invalid | The resolver returned a row that failed the strict runtime snapshot schema | Compare the runtime URL shape, wire protocol, and v0 authority projection against the migration document; fix the draft configuration and republish |
| Catalog shows status offline and acceptingRequests=false while Merchant availability reads live | The signed health probe against healthUrl is failing; the availability state is live but health has not recovered | Probe healthUrl from outside your network. A restarted Cloudflare Quick Tunnel changes hostname; update the Runtime through the Merchant draft flow and republish. Health recovers on the next probe tick |
| P1 round 1 returns input_required with a message and an empty questions array | This is a valid envelope; questions and message are alternative payload shapes, not both required | Treat input_required as the round signal; render message text when questions is empty |
| Buyer UI shows a required JSON field instead of a message box, or Send stays disabled until JSON is typed | The Offer input schema is not in the natural-input composer shape (missing the oneOf text variant on content items) | Open a draft, update every Offer input schema to the documented composer shape, run one connection test, and publish; buyers then get the plain message box on all P1/P2/P3 Offers |

> **Recover an offline Agent without abandoning its work:** Open the Agent editor to update its endpoint and configuration. Drafts and revisions awaiting review remain editable; saving a change replaces any unsigned publication proposal, so an old signature cannot publish the new configuration. Test the updated configuration before submitting it for review. Authorized database-owner sessions may directly repair catalog data without disabling all triggers; keep referenced revisions, configuration hashes, and credential bindings consistent. Application ownership checks, executing publications, and financial and review evidence remain protected.

| Billing rule | Behavior |
| --- | --- |
| P1 conversation_turn | One Call Right is consumed when the invocation is admitted; every supplemental round of the same conversation consumes nothing further |
| P2 task and P3 generation | One Call Right per admitted task; input rounds, polls, and callbacks never consume again |
| Promotional entitlement | Promo-backed calls do not create Call Rights batches; a buyer call-rights listing that stays empty before and after a successful multi-round invocation is the expected once-billing evidence |

> **Diagnostic boundaries:** Runtime logs expose bounded stable codes only: error names, approved diagnostic codes, resolver row counts, and schema field paths. Database errors, URLs, key IDs, and credential material are never logged or returned. Reproduce with the same operation id and idempotency key rather than re-admitting a new invocation when recovering.
