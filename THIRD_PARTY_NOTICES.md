# Third-party notices

## NewAPI user-facing web interface

The Docs Hub and model-pricing presentations in `public/static/app.js` and
`public/static/styles.css` adapt the existing user-facing NewAPI SPA interface
from commit `4d27865ce8342530f362595fdcd134eb83062a35`, including its component
hierarchy, interaction wording, responsive layout contracts, and Semi design
tokens.

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
