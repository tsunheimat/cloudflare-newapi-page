# Third-party notices

## NewAPI user-facing web interface

The Docs Hub and model-pricing presentations in `public/static/app.js` and
`public/static/styles.css` adapt the existing user-facing NewAPI SPA interface
from commit `4d27865ce8342530f362595fdcd134eb83062a35`, including its component
hierarchy, interaction wording, and responsive layout contracts.

The visual layer is this site's own JuAPI design system. The adapted rules now
read their colours, radii, elevation and type from JuAPI tokens through the
`--semi-*` alias block in `public/static/styles.css`, so the layout contracts
above are preserved while the skin is not a copy of the NewAPI theme.

The referenced NewAPI source is copyright (C) 2025 QuantumNous and is licensed
under the GNU Affero General Public License, version 3 or (at your option) any
later version. The complete license text is included in [LICENSE](LICENSE).

Principal reference paths:

- `web/src/pages/DocsHub/`
- `packages/docs-core/src/styles/blocks.css`
- `web/src/pages/Pricing/index.jsx`
- `web/src/components/table/model-pricing/`
- `web/src/index.css`

This Worker adaptation replaces NewAPI runtime/API dependencies with the
repository's existing fixture-backed content adapter and pricing calculator.
It does not alter the referenced NewAPI checkout or its protected attribution.

## JuAPI brand assets

`public/brand/juapi-logo.png`, `public/brand/juapi-logo-dark.png` and
`public/brand/juapi-mark.png` are copied verbatim from the JuAPI deployment's
`web/public/` brand assets. They are the deployer's own marks, used here only
to identify the same service; no other file from that checkout is vendored.

## Canonical Pricing bundle

The authenticated `/console/pricing` surface also ships the built canonical NewAPI React component bundle from approved commit `85143bc49260f9c7ab1efd6a5122558e58d0bee2`; the checked-in `public/static/canonical-pricing.*` files preserve the component surface and attribution.
