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
Docs preserve a syntactically valid upstream `ETag` on public `200` responses
and return an empty public `304` when the verified upstream does. Pricing
projects models in deterministic ascending code-unit order by the public
`model_name` key (using the canonical projected model as a duplicate-name
tie-breaker), sorts vendors by their stable public `id`, and sorts projected
public identifier arrays such as `enable_groups` and
`supported_endpoint_types`. These order-only canonicalization steps do not
change values or semantics. It derives the public pricing `ETag` from that
projected payload, so an equivalent upstream `200` with different model,
vendor, or identifier-array order still returns the same validator and a
matching browser validator is converted to an empty public `304`. Cookies,
sessions, browser authorization, user API keys, and unrelated headers are not
forwarded. The five-second deadline covers binding fetch, body streaming,
UTF-8 decoding, JSON parsing, validation, and projection.

The live Docs projection must provide the existing catalog/page block contract.
Both `schema_version` and `renderer_version` must equal the currently supported
value `1`; future or unknown versions fail closed until explicitly reviewed.
Pricing remains identity-independent and is accepted only when the locked
ordinary-user context is present and every public group ratio is a finite,
non-negative value supplied by NewAPI. The adapter preserves those upstream
ratios, including `group_ratio.default`; it does not normalize, clamp, or
substitute a configured value. The public context is:

```text
context.user_group      = default
context.selected_group  = default
context.locked          = true
group_ratio.default     = <finite upstream value>
```

The live model projection is an explicit compatibility allowlist, not a raw
JSON pass-through. It retains the current NewAPI public fields (`model_name`,
description/icon/tags/vendor/owner presentation, image/video flags, quota and
all legacy ratios, enabled groups and endpoint types, `endpoint_map`,
`billing_mode`/`billing_expr`, `codex_fast_pricing`/`codex_fast_base_model`,
`video_pricing`, video geometry/route/input-duration contracts,
`video_capability`, and row `pricing_version`). Endpoint maps, Fast profiles,
video rate matrices, resolution dimensions, and capability/media objects are
schema-validated with finite numeric, identifier, depth/entry, and byte-size
bounds. Only their documented public fields are projected; secret-like or
unknown keys are redacted. The canonical projected payload (including every
retained nested field) is the input to the stable pricing ETag, so a capability
or route-contract-only change cannot produce a false `304`. The
`video_capability.max_serialized_request_bytes` field has an inclusive finite
upper bound of `64,000,000` bytes, matching the current Seedance 2.5 public
contract; larger or non-integer values fail closed.

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
