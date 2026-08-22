# NewAPI live Docs/Pricing adapter

The Worker has a `CONTENT_ADAPTER` boundary with two modes:

- `fixture` (the default, including the current staging and production vars);
- `newapi` (implemented, but not selected by this branch's safety gates).

The `newapi` mode is read-only. It calls the private NewAPI contract through
the `NEWAPI_VPC_SERVICE` Cloudflare Workers VPC Service binding. The binding is
configured with the reviewed service ID `01a027bb-280d-7630-b837-7afd6a0ca196`.
The configured VPC Service routes to `newapi-api.newapi:3000`; the Worker does
not use the public `www.tokenrouter.tech` origin.

## Secret and binding names

Provision `LIVE_CONTENT_ADAPTER_TOKEN` as a Worker secret and use the same
operator-managed value in NewAPI's `LIVE_CONTENT_ADAPTER_TOKEN` runtime
setting. The value must be high entropy and at least 32 bytes. Do not put it
in `wrangler.toml`, `.env` files, tests, logs, or commits. A missing or short
secret, or a missing VPC binding, returns a bounded 503 and never serves
fixture data.

For an explicitly authorized staging verification, provision the secret with
the environment selected by the operator, for example:

```sh
npx wrangler secret put LIVE_CONTENT_ADAPTER_TOKEN --env staging
```

This command is documentation only for this task; no secret mutation or
deployment was performed.

## Upstream contract and safety behavior

The adapter sends only `GET` requests with `Authorization: Bearer <secret>` to:

```text
/api/internal/live-content/v1/health
/api/internal/live-content/v1/docs?locale=zh
/api/internal/live-content/v1/docs/:slug?locale=zh
/api/internal/live-content/v1/pricing
```

It requires `X-NewAPI-Content-Contract: v1` and `application/json`, aborts
after five seconds, and limits each upstream body to 2 MiB. Health verification
requires upstream HTTP `200` and the complete `{ success: true,
service: "newapi-live-content", contract_version: "v1", read_only: true }`
response contract; a health `304` is unhealthy. Non-2xx responses (other than a
verified Docs page 404 or a validated conditional `304` for Docs/Pricing), transport/timeouts, invalid JSON,
oversized bodies, contract mismatches, and schema violations fail closed with
a generic 503. Backend response bodies and messages are never exposed to the
browser. There is no session-cookie, user API-key, public-origin, or fixture
fallback path in live mode.

For Docs and Pricing, the Worker forwards only the browser's `If-None-Match`
validator in addition to its fixed `Accept` and private adapter authorization.
It preserves a syntactically valid upstream `ETag` on public `200` responses
and returns an empty public `304` when the verified upstream does. Cookies,
sessions, browser authorization, user API keys, and unrelated headers are not
forwarded. The five-second deadline covers binding fetch, body streaming,
UTF-8 decoding, JSON parsing, validation, and projection.

The live Docs projection must provide the existing catalog/page block contract.
Both `schema_version` and `renderer_version` must equal the currently supported
value `1`; future or unknown versions fail closed until explicitly reviewed.
Pricing remains identity-independent and is accepted only when:

```text
context.user_group      = default
context.selected_group  = default
context.locked          = true
group_ratio.default     = 1.25
```

## Cutover and rollback

This branch intentionally leaves top-level, staging, and production
`CONTENT_ADAPTER` values at `fixture`. Before a live cutover, an operator must
verify the VPC/Tunnel path, install the Worker secret, run a staging GET-only
probe against the live contract, review response/renderer/schema samples, and
retain the fixture configuration for rollback. Local tests and Wrangler
`--dry-run` builds do not prove Cloudflare account bindings, Tunnel transport,
secret installation, or production traffic.
