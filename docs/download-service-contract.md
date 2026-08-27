# Download Service Binding rollback contract

The primary Downloads implementation is the NewAPI Worker's R2 authority in
[`src/adapters/downloads.js`](../src/adapters/downloads.js), documented in
[`downloads-r2-authority.md`](downloads-r2-authority.md). This file records
the retained service binding only for rollback and for pre-migration
environments that do not expose the `DOWNLOADS` R2 binding.

## Immutable rollback provenance

The sibling source was reviewed read-only at:

- repository: `/mnt/vibe-coding-share/tokenrouter/cloudflare-download-site`
- commit: `becb3e80dae6e66724b332ebadeb1522cd257d46`
- service: `cloudflare-download-site`

The old Worker and its service binding remain intact. This NewAPI repository
does not deploy, stop, unbind, mutate, or delete that Worker.

## Fallback route families

If a runtime has no callable `DOWNLOADS` R2 binding, the existing explicit
service-binding gate can still carry the old direct and mounted families:

- mounted landing/detail authority routes and assets (the public browser
  document itself is now the JuAPI workspace shell);
- legacy and software-specific latest/public/previous metadata and targets;
- download redirects/streams;
- WeChat QR metadata/image;
- admin login/session/logout, QR upload, and public lock/unlock/set actions.

When `DOWNLOADS` is present, `src/worker.js` dispatches these route families to
the local R2 authority first and never calls `DOWNLOADS_SERVICE`. The old
transport is therefore a rollback seam, not a dependency of migrated
production Downloads.

The old transport contract remains method/body/query/header-preserving and
credentials are never synthesized by the NewAPI Worker. The read-only probes
may exercise GET/HEAD fallback behavior, but do not perform admin POSTs.
