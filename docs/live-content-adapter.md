# NewAPI live Docs/Pricing adapter

The Worker has a `CONTENT_ADAPTER` boundary with two modes:

- `fixture` (the default, including the current top-level and staging vars);
- `newapi` (selected only by the explicitly authorized production named environment).

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
/api/internal/live-content/v1/docs/v2/navigation?locale=zh
/api/internal/live-content/v1/docs/v2/config
/api/internal/live-content/v1/docs/v2/spaces
/api/internal/live-content/v1/docs/v2/tree
/api/internal/live-content/v1/docs/v2/search
/api/internal/live-content/v1/docs/v2/featured
/api/internal/live-content/v1/docs/v2/recent
/api/internal/live-content/v1/docs/v2/redirect
/api/internal/live-content/v1/docs/v2/pages/by-id/:id
/api/internal/live-content/v1/docs/v2/pages/:slug
/api/internal/live-content/v1/docs/v2/assets/:id
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
a generic 503. Navigation is bounded to 8 MiB because it is recursive; the
catalog/page/Pricing paths retain their 2 MiB bound. Backend response bodies
and messages are never exposed to the browser. There is no session-cookie,
user API-key, public-origin, or fixture fallback path in live mode.

The canonical DocsHub same-origin routes (`/api/docs/v2/*`) use the approved
token-only NewAPI endpoints over the same VPC binding. The legacy public
recursive compatibility URL (`/api/front-door/v1/docs/v2/navigation`) remains
available separately. Each route forwards only the Worker-held
`Authorization: Bearer <LIVE_CONTENT_ADAPTER_TOKEN>` and fixed
`Accept: application/json`, plus an optional `If-None-Match` validator.
Browser cookies, `New-Api-User`, browser Authorization, API keys,
admin/provider credentials, arbitrary browser headers, and end-user logic are
never inspected or forwarded. The response is the published normal/public
recursive folder/layer/group/page tree; the Worker applies a bounded public
allowlist, omits unknown/private fields, and fails closed on malformed known
fields. Public Docs responses preserve validated upstream ETags and use the
Worker's `no-cache` response policy; a verified conditional `304` remains an
empty `304`. `/api/pricing` is the canonical public Pricing route (with
`/api/content/pricing` retained only as a compatibility alias) and remains on
the existing service-token adapter regardless of `New-Api-User` or any browser
session.

The browser boundary follows the same rule: the canonical Pricing bundle makes
a fresh public `/api/pricing` request with credentials and secure-API signing
disabled. It uses no browser user/session state. Both `/console/pricing` and
`/pricing` mount this same bundle and data path.

The canonical `/console/pricing` bundle separately calls the public same-origin
`/api/status` bootstrap. This is a read-only fixed token-authenticated
`GET /api/internal/live-content/v1/status` through `NEWAPI_VPC_SERVICE`; it
sends only the Worker token Authorization and `Accept: application/json` and
never copies browser cookies, browser Authorization, API keys, provider
credentials, or arbitrary headers. The Worker omits secure-API signing
material. The Worker
bounds the response to 256 KiB and five seconds, requires a
JSON `{ success: true, data: object }` envelope, validates any canonical display
settings that are present, projects only the reviewed public status fields, and
returns a generic 503 on any upstream, body, timeout, or schema failure. It has
no fixture or localStorage-derived display fallback; the canonical component's
own display defaults remain in effect when anonymous status omits those fields.

For the service-token live adapter, the Worker forwards only the browser's
`If-None-Match` validator in addition to its fixed `Accept` and private adapter
authorization.
Docs preserve a syntactically valid upstream `ETag` on public `200` responses.
An upstream Docs `304` becomes an empty public `304` only when this request
forwarded a browser `If-None-Match` validator and the upstream `ETag` weakly
matches one of its quote-aware entity tags (or its wildcard); missing or
mismatched validators fail closed with 503. A Docs `200` is never converted to
a local `304`. Pricing is passed through byte-for-byte from the canonical
backend; the Worker does not sort, project, redact, reconstruct, or derive a
pricing ETag from parsed values. Cookies, sessions, browser authorization, user
API keys, and unrelated headers are not forwarded by the public Docs or Pricing
adapter. The five-second deadline covers binding fetch, body streaming, UTF-8
decoding, and the minimal envelope check.

The live Docs projection must provide the existing catalog/page block contract.
Both `schema_version` and `renderer_version` must equal the currently supported
value `1`; future or unknown versions fail closed until explicitly reviewed.
Pricing remains identity-independent and is accepted when the canonical backend
returns a successful JSON envelope. All public fields, ordering, arbitrary
group names, ratios, capabilities, and future fields are retained exactly;
there is no Worker-side pricing allowlist or context reconstruction.

The browser keeps NewAPI's two pricing modes: official mode uses effective
ratio `1` and raw/base official USD prices, while ordinary group mode uses the
upstream selected default group ratio. This applies consistently to legacy
ratio, per-request, tiered-expression, Codex Fast, and video calculations;
there is no fixed replacement ratio or invented model logic.

## Cutover and rollback

Top-level and staging remain explicitly fixture-backed. The authorized
production named environment selects `CONTENT_ADAPTER="newapi"` and requires
the reviewed `NEWAPI_VPC_SERVICE` binding plus `LIVE_CONTENT_ADAPTER_TOKEN`.
The guarded production preflight exercises the live health, Docs, and Pricing
contract with a deterministic local binding mock; it rejects production if the
named environment is changed back to fixture or any other mode. The controller
has separately verified the production Worker version, secret, VPC service,
private route, and NewAPI runtime prerequisites for this cutover.

Rollback is a controller-owned deployment decision: retain the previous Worker
version ID outside this repository and use the production runbook if live
verification fails. Local tests and Wrangler `--dry-run` builds do not prove
Cloudflare account bindings, Tunnel transport, secret installation, or
production traffic.
