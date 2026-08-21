import { docsFixture } from '../fixtures/docs.js';
import { pricingFixture } from '../fixtures/pricing.js';
import { HttpError } from '../http.js';

export const CONTENT_ADAPTER_FIXTURE = 'fixture';
export const LOCKED_PRICING_CONTEXT = Object.freeze({
  user_group: 'default',
  selected_group: 'default',
});

export function createContentAdapter(env = {}) {
  const mode = String(env.CONTENT_ADAPTER || CONTENT_ADAPTER_FIXTURE)
    .trim()
    .toLowerCase();

  if (mode === CONTENT_ADAPTER_FIXTURE) {
    return createFixtureAdapter();
  }

  throw new HttpError(
    503,
    `Content adapter "${mode}" is not available in phase 1.`,
    {
      configured_adapter: mode,
      live_integration: false,
    },
  );
}

export function createFixtureAdapter() {
  return {
    name: CONTENT_ADAPTER_FIXTURE,
    live: false,

    async getDocsCatalog() {
      return clone({
        meta: docsFixture.meta,
        sections: docsFixture.sections,
        search_index: docsFixture.search_index,
      });
    },

    async getDocPage(slug) {
      const page = docsFixture.pages.find((candidate) => candidate.slug === slug);
      if (!page) {
        throw new HttpError(404, 'Document page not found.');
      }
      return clone({ meta: docsFixture.meta, page });
    },

    async getPricing() {
      assertOrdinaryUserPricingContext(pricingFixture);
      return clone(pricingFixture);
    },
  };
}

export function assertOrdinaryUserPricingContext(payload) {
  const userGroup = payload?.context?.user_group;
  const selectedGroup = payload?.context?.selected_group;
  if (
    userGroup !== LOCKED_PRICING_CONTEXT.user_group ||
    selectedGroup !== LOCKED_PRICING_CONTEXT.selected_group
  ) {
    throw new HttpError(500, 'Pricing adapter returned an invalid user context.');
  }
  if (payload?.context?.locked !== true) {
    throw new HttpError(500, 'Pricing adapter must lock the public pricing group.');
  }
  if (!(LOCKED_PRICING_CONTEXT.selected_group in (payload.group_ratio || {}))) {
    throw new HttpError(500, 'Pricing adapter omitted the default group ratio.');
  }
  const defaultGroupRatio = Number(
    payload.group_ratio[LOCKED_PRICING_CONTEXT.selected_group],
  );
  if (!Number.isFinite(defaultGroupRatio) || defaultGroupRatio < 0) {
    throw new HttpError(
      500,
      'Pricing adapter returned an invalid default group ratio.',
    );
  }
  if (!(LOCKED_PRICING_CONTEXT.selected_group in (payload.usable_group || {}))) {
    throw new HttpError(500, 'Pricing adapter omitted the default usable group.');
  }
  return payload;
}

function clone(value) {
  return structuredClone(value);
}
