# Third-party notices

## NewAPI user-facing web interface

The public `/console/pricing` surface is the built canonical NewAPI
React component surface from approved commit
`85143bc49260f9c7ab1efd6a5122558e58d0bee2`, including `PricingPage`,
`useModelPricingData`, `PricingTopSection`, `pricingPresentation`, filters,
table/card views, and `ModelDetailSideSheet`. The Worker keeps its existing
Docs reader compatibility renderer, while authenticated Docs navigation uses
the same commit's recursive front-door contract.

The referenced NewAPI source is copyright (C) 2025 QuantumNous and is licensed
under the GNU Affero General Public License, version 3 or (at your option) any
later version. The complete license text is included in [LICENSE](LICENSE).

Principal reference paths:

- `web/src/pages/DocsHub/`
- `packages/docs-core/src/styles/blocks.css`
- `web/src/pages/Pricing/index.jsx`
- `web/src/components/table/model-pricing/`
- `web/src/index.css`

The generated browser bundle is checked into `public/static/canonical-pricing.*`
so deployment does not depend on a NewAPI checkout or external CDN. The build
does not alter the referenced NewAPI checkout or its protected attribution.
