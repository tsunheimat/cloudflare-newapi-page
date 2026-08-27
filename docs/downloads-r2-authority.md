# Downloads R2 authority migration

The NewAPI Worker now owns the Downloads route families in
`src/adapters/downloads.js`. It uses the production R2 binding `DOWNLOADS`
(`tokenrouter`) as the sole metadata, release/state, artifact, and WeChat QR
authority. The two existing software profiles are retained:

- `codex-installer` under `R2_PREFIX` (`codex-install`)
- `codex-chat-record-migrator` under its existing prefix and public-base var

The Worker reads the existing `metadata`, `state`, `releases`, `public`, and
QR objects without copying release data into source. Artifact `r2_key` values
are validated before any redirect; embedded URLs are accepted only when they
are HTTPS URLs for the configured public base and the exact validated key.
Unsafe URLs are ignored and safely derived from the reviewed public base
variables. QR image metadata is validated against the configured
`wechat-group-qrcode/images/` prefix before redirecting or streaming.

The complete direct and mounted authority families are handled locally:
catalog/detail data APIs, static assets, legacy and software-specific latest/public/
previous APIs, target metadata, download redirects/streaming, QR image/latest
routes, admin login/session/logout, public lock/unlock/set actions, and QR
upload. Admin sessions are HMAC-SHA256 cookies signed with
`ADMIN_SESSION_SECRET`; login and all session use fail closed until both
`ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` are provisioned. No password,
access key, or other secret is stored in this repository.
Every admin POST also requires a per-session constant-time CSRF token and
same-origin validation. QR publication compensates metadata/state writes on
failure and returns only a generic 503. Each upload owns a Web Crypto random
operation ID and a separate immutable generation ID. The existing
`state/pending.json`, `metadata/latest.json`, `state/latest.json`, and image
key families remain in place, while R2 conditional puts prevent one operation
from replacing another operation's fence. New metadata/state records include
the exact generation and full publication identity.

QR writers verify every ambiguous R2 put outcome with an immediate read-back.
Marker transitions use the owning operation and the current object ETag.
Committed markers are retained as durable generation fences; failed
compensations become owner-checked tombstones, and no read-to-delete cleanup
is used. Public metadata/image routes and authenticated admin reads return a
bounded 503 for unresolved pending/tombstone markers, mismatched latest/state
records, or missing/replaced/drifted new-generation image objects. A tombstone
is readable only after its recorded rollback pair and any prior new-generation
image have been verified. Existing legacy
metadata-only QR objects remain readable within their documented limits, and
no migration rewrites existing R2 objects.

When `DOWNLOADS_INTEGRATION=production-r2-binding`, migrated routes require
callable `DOWNLOADS.get` and `DOWNLOADS.put`; missing or invalid bindings fail
closed with a generic 503 and never call `DOWNLOADS_SERVICE`. When `DOWNLOADS`
is present in the unqualified local/test mode, migrated routes likewise never
call `DOWNLOADS_SERVICE`.
The legacy service binding remains declared as a rollback path for the
existing Worker and for environments that have not yet supplied the R2
binding; that fallback is intentionally unreachable in the R2-shaped
production request path.

The exact reviewed public variables are configured in `wrangler.toml`:

```text
R2_PREFIX=codex-install
R2_PUBLIC_BASE_URL=https://tokenrouter-r2.wdtokenacc.top
JUAPI_HOME_URL=https://www.juaiapi.com
WECHAT_GROUP_QR_PREFIX=wechat-group-qrcode
WECHAT_GROUP_QR_PUBLIC_BASE_URL=https://tokenrouter-r2.wdtokenacc.top
CODEX_CHAT_RECORD_MIGRATOR_R2_PUBLIC_BASE_URL=https://tokenrouter-r2.wdtokenacc.top
```

Local tests use an in-memory R2 double and do not mutate the real bucket.
Production deployment, Cloudflare binding resolution, live R2 object
availability, and browser acceptance remain live verification gates outside
this source-only change.
