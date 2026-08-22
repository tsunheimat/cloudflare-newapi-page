export const ORDINARY_USER_GROUP = 'default';
export const ORDINARY_SELECTED_GROUP = 'default';
export const PRICING_MODE_TIERED = 'tiered_expr';
export const PRICING_MODE_VIDEO = 'video';
export const VIDEO_SETTLEMENT_UNIT = 'per_1m_completion_tokens';
export const BILLING_EXPR_GRAMMAR_VERSION = 1;
export const BILLING_EXPR_CONTRACT = 'newapi-billing-expr-v1';

// Mirrors NewAPI web/src/constants/billing.constants.js for the v1 compile
// environment. Unknown variables must make the whole display parse fail.
export const BILLING_VARIABLES = Object.freeze([
  Object.freeze({ key: 'p', field: 'input', label: '输入', side: 'input' }),
  Object.freeze({ key: 'c', field: 'output', label: '输出', side: 'output' }),
  Object.freeze({ key: 'cr', field: 'cacheRead', label: '缓存读取', side: 'input' }),
  Object.freeze({ key: 'cc', field: 'cacheCreate', label: '缓存创建', side: 'input' }),
  Object.freeze({ key: 'cc1h', field: 'cacheCreate1h', label: '1h 缓存创建', side: 'input' }),
  Object.freeze({ key: 'img', field: 'image', label: '图片输入', side: 'input' }),
  Object.freeze({ key: 'img_o', field: 'imageOutput', label: '图片输出', side: 'output' }),
  Object.freeze({ key: 'ai', field: 'audioInput', label: '音频输入', side: 'input' }),
  Object.freeze({ key: 'ao', field: 'audioOutput', label: '音频输出', side: 'output' }),
]);

const BILLING_FIELD_BY_VARIABLE = Object.freeze(
  Object.fromEntries(BILLING_VARIABLES.map(({ key, field }) => [key, field])),
);
const BILLING_LABEL_BY_FIELD = Object.freeze(
  Object.fromEntries(BILLING_VARIABLES.map(({ field, label }) => [field, label])),
);
const BILLING_VARIABLE_PATTERN = BILLING_VARIABLES
  .map(({ key }) => key)
  .sort((left, right) => right.length - left.length)
  .join('|');
const NUMBER_SOURCE = '(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const JSON_STRING_SOURCE = '"(?:[^"\\\\]|\\\\.)*"';
const DISPLAY_CURRENCIES = new Set(['USD', 'CNY', 'CUSTOM']);

export function assertOrdinaryPricingPayload(payload) {
  if (
    payload?.context?.user_group !== ORDINARY_USER_GROUP ||
    payload?.context?.selected_group !== ORDINARY_SELECTED_GROUP ||
    payload?.context?.locked !== true
  ) {
    throw new Error('Pricing payload is not locked to default/default.');
  }
  if (!(ORDINARY_SELECTED_GROUP in (payload?.group_ratio || {}))) {
    throw new Error('Pricing payload has no default group ratio.');
  }
  const ratio = finiteNumber(payload.group_ratio[ORDINARY_SELECTED_GROUP]);
  if (ratio === null || ratio < 0) {
    throw new Error('Default group ratio must be finite and non-negative.');
  }
  if (!(ORDINARY_SELECTED_GROUP in (payload?.usable_group || {}))) {
    throw new Error('Pricing payload has no default usable group.');
  }
  return payload;
}

export function modelSupportsGroup(model, group = ORDINARY_SELECTED_GROUP) {
  const enabled = Array.isArray(model?.enable_groups)
    ? model.enable_groups
    : [];
  return (
    enabled.length === 0 || enabled.includes('all') || enabled.includes(group)
  );
}

export function getOrdinaryUserModels(payload) {
  assertOrdinaryPricingPayload(payload);
  return (Array.isArray(payload.data) ? payload.data : []).filter((model) =>
    modelSupportsGroup(model, ORDINARY_SELECTED_GROUP),
  );
}

export function getDefaultGroupRatio(payload) {
  assertOrdinaryPricingPayload(payload);
  return Number(payload.group_ratio[ORDINARY_SELECTED_GROUP]);
}

// This is the displayPrice sequence used by NewAPI's model marketplace:
// nominal USD -> optional recharge conversion -> selected display currency.
export function convertPricingDisplayValue({
  usdPrice,
  currency = 'USD',
  priceRate = 1,
  usdExchangeRate = 1,
  customExchangeRate = 1,
  applyRecharge = false,
}) {
  let value = nonNegativeNumber(usdPrice);
  const selectedCurrency = String(currency).toUpperCase();
  if (value === null || !DISPLAY_CURRENCIES.has(selectedCurrency)) return null;

  const usdRate = positiveNumber(usdExchangeRate);
  if (applyRecharge) {
    const price = nonNegativeNumber(priceRate);
    if (price === null || usdRate === null) return null;
    value = (value * price) / usdRate;
  }

  if (selectedCurrency === 'CNY') {
    if (usdRate === null) return null;
    value *= usdRate;
  }
  if (selectedCurrency === 'CUSTOM') {
    // NewAPI falls back to 1 when the configured custom rate is missing,
    // zero, or otherwise unusable.
    value *= positiveNumber(customExchangeRate) ?? 1;
  }
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeSourcePriceToUSD({
  sourcePrice,
  sourceCurrency,
  usdExchangeRate,
}) {
  const amount = nonNegativeNumber(sourcePrice);
  const currency = String(sourceCurrency).toUpperCase();
  if (amount === null) return null;
  if (currency === 'USD') return amount;
  if (currency === 'CNY') {
    const usdRate = positiveNumber(usdExchangeRate);
    return usdRate === null ? null : amount / usdRate;
  }
  return null;
}

export function calculateModelPricing(model, payload, options = {}) {
  assertOrdinaryPricingPayload(payload);
  if (!modelSupportsGroup(model, ORDINARY_SELECTED_GROUP)) return null;

  const groupRatio = getDefaultGroupRatio(payload);
  const display = normalizeDisplaySettings(payload.display, options);
  const common = {
    group: ORDINARY_SELECTED_GROUP,
    groupRatio,
    model,
  };

  // Explicit native billing modes are authoritative and never fall through to
  // legacy quota_type fields.
  if (model.billing_mode === PRICING_MODE_VIDEO) {
    return calculateVideoPricing(model, payload, display, common);
  }
  if (model.billing_mode === PRICING_MODE_TIERED) {
    return calculateTieredPricing(model, display, common);
  }

  if (
    model.billing_mode !== undefined &&
    model.billing_mode !== null &&
    (typeof model.billing_mode !== 'string' || model.billing_mode.trim() !== '')
  ) {
    return unavailablePricing(
      common,
      'unknown',
      'unsupported_billing_mode',
      '未知计费模式，无法计算。',
    );
  }

  if (!display) {
    return unavailablePricing(
      common,
      model.quota_type === 1 ? 'per_request' : 'per_token',
      'invalid_display_settings',
      '价格显示参数不完整。',
    );
  }

  if (model.quota_type === 0) {
    return calculatePerTokenPricing(model, display, common);
  }
  if (model.quota_type === 1) {
    return calculatePerRequestPricing(model, display, common);
  }
  return unavailablePricing(
    common,
    'unknown',
    'unknown_quota_type',
    '未知计费类型，无法计算。',
  );
}

export function parseBillingExpression(expression) {
  const failed = (errorCode, error) => ({
    contract: BILLING_EXPR_CONTRACT,
    version: null,
    complete: false,
    conditional: false,
    tiers: [],
    requestRule: null,
    errorCode,
    error,
  });

  if (typeof expression !== 'string' || expression.trim() === '') {
    return failed('missing_expression', '计费表达式为空。');
  }

  let body = expression.trim();
  let version = BILLING_EXPR_GRAMMAR_VERSION;
  const versionMatch = body.match(/^v(\d+):/);
  if (versionMatch) {
    version = Number(versionMatch[1]);
    body = body.slice(versionMatch[0].length).trim();
  }
  if (version !== BILLING_EXPR_GRAMMAR_VERSION) {
    return {
      ...failed('unsupported_version', `不支持计费表达式 v${version}。`),
      version,
    };
  }

  const suffixParts = splitOutsideStrings(body, '|||');
  if (suffixParts.length > 2) {
    return {
      ...failed('invalid_request_rule', '请求规则后缀包含多个分隔符。'),
      version,
    };
  }
  const baseExpression = suffixParts[0].trim();
  const hasRequestRule = suffixParts.length === 2;
  const suffix = hasRequestRule ? suffixParts[1].trim() : '';
  const requestRule = hasRequestRule ? parseRequestRuleSuffix(suffix) : null;
  if (hasRequestRule && !requestRule) {
    return {
      ...failed('invalid_request_rule', '请求规则后缀无法完整解析。'),
      version,
    };
  }

  const tiers = [];
  const parsed = parseTierTree(baseExpression, [], tiers);
  if (!parsed || tiers.length === 0) {
    return {
      ...failed('unsupported_expression', '表达式无法按 NewAPI v1 显示语法完整解析。'),
      version,
    };
  }

  return {
    contract: BILLING_EXPR_CONTRACT,
    version,
    complete: true,
    conditional: tiers.length > 1 || requestRule !== null,
    tiers,
    requestRule,
    errorCode: null,
    error: null,
  };
}

// Compatibility helper. Callers that need to distinguish an empty expression
// from a rejected partial parse must use parseBillingExpression().
export function parseBillingTiers(expression) {
  const parsed = parseBillingExpression(expression);
  return parsed.complete ? parsed.tiers : [];
}

export function getVideoResolutionRows({
  model,
  display,
  groupRatio,
  resolutionDimensions = {},
}) {
  if (!isVideoBillingModel(model) || !display) return null;
  const profile = model.video_pricing;
  if (profile.version !== 1) return null;

  const multiplier = strictPositiveNumber(profile.rate_multiplier);
  const ratio = nonNegativeNumber(groupRatio);
  const sourceCurrency = String(profile.currency).toUpperCase();
  const resolutionRates = profile.resolution_rates;
  const resolutions = Object.keys(resolutionRates);
  if (
    multiplier === null ||
    ratio === null ||
    !['USD', 'CNY'].includes(sourceCurrency) ||
    resolutions.length === 0
  ) {
    return null;
  }

  const rows = [];
  for (const resolution of resolutions.sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  )) {
    const rates = resolutionRates[resolution];
    if (!rates || typeof rates !== 'object') return null;
    const withoutVideo = buildVideoRate({
      sourcePrice: rates.without_video,
      sourceCurrency,
      multiplier,
      groupRatio: ratio,
      display,
      key: 'withoutVideo',
      label: '无输入视频',
    });
    const withVideo = buildVideoRate({
      sourcePrice: rates.with_video,
      sourceCurrency,
      multiplier,
      groupRatio: ratio,
      display,
      key: 'withVideo',
      label: '有输入视频',
    });
    if (!withoutVideo || !withVideo) return null;
    rows.push({
      resolution,
      dimensions: resolutionDimensions?.[resolution] || null,
      sourceCurrency,
      withoutVideo,
      withVideo,
    });
  }
  return rows;
}

export function isVideoBillingModel(model) {
  return Boolean(
    model?.billing_mode === PRICING_MODE_VIDEO &&
      model.video_pricing &&
      typeof model.video_pricing === 'object' &&
      model.video_pricing.unit === VIDEO_SETTLEMENT_UNIT &&
      model.video_pricing.resolution_rates &&
      typeof model.video_pricing.resolution_rates === 'object' &&
      !Array.isArray(model.video_pricing.resolution_rates),
  );
}

function calculatePerTokenPricing(model, display, common) {
  const modelRatio = nonNegativeNumber(model.model_ratio);
  const completionRatio = nonNegativeNumber(model.completion_ratio);
  const optionalFields = [
    'cache_ratio',
    'create_cache_ratio',
    'image_ratio',
    'audio_ratio',
    'audio_completion_ratio',
  ];
  if (
    modelRatio === null ||
    completionRatio === null ||
    optionalFields.some((field) =>
      isPresent(model[field]) && nonNegativeNumber(model[field]) === null,
    ) ||
    (isPresent(model.audio_completion_ratio) && !isPresent(model.audio_ratio))
  ) {
    return unavailablePricing(
      common,
      'per_token',
      'invalid_model_ratio',
      '按量计费倍率不完整。',
    );
  }

  const baseInputUSD = modelRatio * 2 * common.groupRatio;
  const prices = {
    input: baseInputUSD,
    output: baseInputUSD * completionRatio,
    cacheRead: multiplyOptional(baseInputUSD, model.cache_ratio),
    cacheCreate: multiplyOptional(baseInputUSD, model.create_cache_ratio),
    image: multiplyOptional(baseInputUSD, model.image_ratio),
    audioInput: multiplyOptional(baseInputUSD, model.audio_ratio),
    audioOutput:
      isPresent(model.audio_ratio) && isPresent(model.audio_completion_ratio)
        ? baseInputUSD * Number(model.audio_ratio) * Number(model.audio_completion_ratio)
        : null,
  };
  if (Object.values(prices).some((value) => value !== null && !isNonNegativeFinite(value))) {
    return unavailablePricing(
      common,
      'per_token',
      'invalid_calculated_price',
      '按量计费结果超出可计算范围。',
    );
  }
  const items = priceItems(prices, display, display.tokenUnit);
  if (!items) {
    return unavailablePricing(
      common,
      'per_token',
      'invalid_display_conversion',
      '按量价格无法换算为所选币种。',
    );
  }
  return {
    ...common,
    kind: 'per_token',
    availability: 'available',
    unit: display.tokenUnit === 'K' ? '1K tokens' : '1M tokens',
    pricesUSD: prices,
    items,
  };
}

function calculatePerRequestPricing(model, display, common) {
  const modelPrice = nonNegativeNumber(model.model_price);
  const priceUSD = modelPrice === null ? null : modelPrice * common.groupRatio;
  if (priceUSD === null || !isNonNegativeFinite(priceUSD)) {
    return unavailablePricing(
      common,
      'per_request',
      'invalid_model_price',
      '按次价格不完整。',
    );
  }
  const item = displayItem('request', '每次请求', priceUSD, display, null);
  if (!item) {
    return unavailablePricing(
      common,
      'per_request',
      'invalid_display_conversion',
      '按次价格无法换算为所选币种。',
    );
  }
  return {
    ...common,
    kind: 'per_request',
    availability: 'available',
    unit: '次',
    pricesUSD: { request: priceUSD },
    items: [item],
  };
}

function calculateTieredPricing(model, display, common) {
  const parsed = parseBillingExpression(model.billing_expr);
  if (!parsed.complete) {
    return unavailablePricing(
      common,
      'tiered_expr',
      parsed.errorCode,
      `动态价格不可计算：${parsed.error}`,
      {
        billingExpr: model.billing_expr,
        parseComplete: false,
        tiers: [],
        requestRule: null,
      },
    );
  }
  if (!display) {
    return unavailablePricing(
      common,
      'tiered_expr',
      'invalid_display_settings',
      '动态价格显示参数不完整。',
      { billingExpr: model.billing_expr, parseComplete: false, tiers: [] },
    );
  }

  const tiers = [];
  for (const tier of parsed.tiers) {
    const pricesUSD = Object.fromEntries(
      Object.entries(tier.pricesUSD).map(([key, value]) => [
        key,
        value * common.groupRatio,
      ]),
    );
    if (Object.values(pricesUSD).some((value) => !isNonNegativeFinite(value))) {
      return unavailablePricing(
        common,
        'tiered_expr',
        'invalid_calculated_price',
        '动态价格超出可计算范围。',
        { billingExpr: model.billing_expr, parseComplete: false, tiers: [] },
      );
    }
    const items = priceItems(pricesUSD, display, display.tokenUnit);
    if (!items) {
      return unavailablePricing(
        common,
        'tiered_expr',
        'invalid_display_conversion',
        '动态价格无法换算为所选币种。',
        { billingExpr: model.billing_expr, parseComplete: false, tiers: [] },
      );
    }
    tiers.push({ ...tier, pricesUSD, items });
  }

  return {
    ...common,
    kind: 'tiered_expr',
    availability: 'context_required',
    unit: display.tokenUnit === 'K' ? '1K tokens' : '1M tokens',
    billingExpr: model.billing_expr,
    parseComplete: true,
    expressionVersion: parsed.version,
    requestRule: parsed.requestRule,
    tiers,
    // There is deliberately no top-level pricesUSD/items projection: a tier
    // and request context must be selected before a final price exists.
    items: [],
  };
}

function calculateVideoPricing(model, payload, display, common) {
  if (!display) {
    return unavailablePricing(
      common,
      'video',
      'invalid_display_settings',
      '影片价格显示参数不完整。',
      { rows: [] },
    );
  }
  const rows = getVideoResolutionRows({
    model,
    display,
    groupRatio: common.groupRatio,
    resolutionDimensions: payload.video_resolution_dimensions,
  });
  if (!rows) {
    return unavailablePricing(
      common,
      'video',
      'invalid_video_profile',
      '影片价格档案不完整或来源币种不受支持。',
      { rows: [] },
    );
  }
  const candidates = rows.flatMap((row) => [
    row.withoutVideo.usdPrice,
    row.withVideo.usdPrice,
  ]);
  const startingRateUSD = Math.min(...candidates);
  const startingItem = displayItem(
    'starting',
    '起价',
    startingRateUSD,
    display,
    null,
  );
  if (!startingItem) {
    return unavailablePricing(
      common,
      'video',
      'invalid_display_conversion',
      '影片价格无法换算为所选币种。',
      { rows: [] },
    );
  }
  return {
    ...common,
    kind: 'video',
    availability: 'available',
    unit: '1M 影片补全 tokens',
    sourceCurrency: rows[0].sourceCurrency,
    rows,
    startingRateUSD,
    pricesUSD: { starting: startingRateUSD },
    items: [startingItem],
  };
}

function buildVideoRate({
  sourcePrice,
  sourceCurrency,
  multiplier,
  groupRatio,
  display,
  key,
  label,
}) {
  const numericSourcePrice = nonNegativeNumber(sourcePrice);
  if (numericSourcePrice === null) return null;
  const normalizedUSD = normalizeSourcePriceToUSD({
    sourcePrice: numericSourcePrice * multiplier,
    sourceCurrency,
    usdExchangeRate: display.usd_exchange_rate,
  });
  const usdPrice = normalizedUSD === null ? null : normalizedUSD * groupRatio;
  if (!isNonNegativeFinite(usdPrice)) return null;
  const item = displayItem(key, label, usdPrice, display, null);
  if (!item) return null;
  return {
    ...item,
    sourcePrice: numericSourcePrice,
    sourceCurrency,
    rateMultiplier: multiplier,
  };
}

function parseTierTree(rawExpression, inheritedConditions, tiers) {
  const expression = stripFullOuterParentheses(rawExpression.trim());
  if (!expression) return false;
  const ternary = findTopLevelTernary(expression);
  if (!ternary) {
    const tier = parseTierCall(expression);
    if (!tier) return false;
    tiers.push({
      ...tier,
      condition: inheritedConditions.join(' && '),
    });
    return true;
  }

  const condition = parseTierCondition(expression.slice(0, ternary.question));
  if (!condition) return false;
  const whenTrue = expression.slice(ternary.question + 1, ternary.colon);
  const whenFalse = expression.slice(ternary.colon + 1);
  return (
    parseTierTree(whenTrue, [...inheritedConditions, condition], tiers) &&
    parseTierTree(
      whenFalse,
      [...inheritedConditions, `otherwise(${condition})`],
      tiers,
    )
  );
}

function parseTierCall(rawExpression) {
  const expression = rawExpression.trim();
  if (!expression.startsWith('tier')) return null;
  const open = expression.indexOf('(');
  if (open < 0 || expression.slice(0, open).trim() !== 'tier') return null;
  const close = findMatchingParenthesis(expression, open);
  if (close !== expression.length - 1) return null;
  const argumentsText = expression.slice(open + 1, close);
  const comma = findTopLevelCharacter(argumentsText, ',');
  if (comma < 0) return null;

  let label;
  try {
    label = JSON.parse(argumentsText.slice(0, comma).trim());
  } catch {
    return null;
  }
  if (typeof label !== 'string') return null;
  const pricesUSD = parseTierCost(argumentsText.slice(comma + 1));
  if (!pricesUSD) return null;
  return { label, pricesUSD };
}

function parseTierCost(rawCost) {
  const cost = stripFullOuterParentheses(rawCost.trim());
  const terms = splitTopLevelAdd(cost);
  if (!terms || terms.length === 0) return null;
  const termPattern = new RegExp(
    `^(${BILLING_VARIABLE_PATTERN})\\s*\\*\\s*(${NUMBER_SOURCE})$`,
  );
  const prices = {};
  for (const rawTerm of terms) {
    const match = stripFullOuterParentheses(rawTerm.trim()).match(termPattern);
    if (!match || match[1] in prices) return null;
    const coefficient = nonNegativeNumber(match[2]);
    if (coefficient === null) return null;
    prices[match[1]] = coefficient;
  }
  return Object.fromEntries(
    Object.entries(prices).map(([key, value]) => [
      BILLING_FIELD_BY_VARIABLE[key],
      value,
    ]),
  );
}

function parseTierCondition(rawCondition) {
  const condition = stripFullOuterParentheses(rawCondition.trim());
  const parts = splitTopLevelOperator(condition, '&&');
  if (!parts) return null;
  const conditionPattern = new RegExp(
    `^(p|c|len)\\s*(<=|>=|<|>)\\s*(${NUMBER_SOURCE})$`,
  );
  const normalized = [];
  for (const rawPart of parts) {
    const match = stripFullOuterParentheses(rawPart.trim()).match(conditionPattern);
    if (!match || nonNegativeNumber(match[3]) === null) return null;
    normalized.push(`${match[1]} ${match[2]} ${Number(match[3])}`);
  }
  return normalized.length > 0 ? normalized.join(' && ') : null;
}

function parseRequestRuleSuffix(rawSuffix) {
  const suffix = rawSuffix.trim();
  if (!suffix.startsWith('when(')) return null;
  const open = suffix.indexOf('(');
  const close = findMatchingParenthesis(suffix, open);
  if (close < 0) return null;
  const condition = parseRequestRuleCondition(
    suffix.slice(open + 1, close),
  );
  const trailing = suffix.slice(close + 1).trim();
  const multiplierMatch = trailing.match(
    new RegExp(`^\\*\\s*(${NUMBER_SOURCE})$`),
  );
  const multiplier = multiplierMatch
    ? nonNegativeNumber(multiplierMatch[1])
    : null;
  if (!condition || multiplier === null) return null;
  return { raw: suffix, condition, multiplier };
}

function parseRequestRuleCondition(rawCondition) {
  const condition = stripFullOuterParentheses(rawCondition.trim());
  const headerContainsPattern = new RegExp(
    `^header\\s*\\(\\s*(${JSON_STRING_SOURCE})\\s*\\)\\s+has\\s+(${JSON_STRING_SOURCE})$`,
  );
  const match = condition.match(headerContainsPattern);
  if (!match) return null;

  let headerName;
  let expectedValue;
  try {
    headerName = JSON.parse(match[1]);
    expectedValue = JSON.parse(match[2]);
  } catch {
    return null;
  }
  if (
    typeof headerName !== 'string' ||
    headerName.trim() === '' ||
    typeof expectedValue !== 'string' ||
    expectedValue === ''
  ) {
    return null;
  }
  return condition;
}

function findTopLevelTernary(expression) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let question = -1;
  let nestedQuestions = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (depth === 0 && character === '?') {
      if (question < 0) question = index;
      else nestedQuestions += 1;
    } else if (depth === 0 && character === ':' && question >= 0) {
      if (nestedQuestions === 0) return { question, colon: index };
      nestedQuestions -= 1;
    }
    if (depth < 0) return null;
  }
  return null;
}

function findMatchingParenthesis(text, openIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function findTopLevelCharacter(text, target) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (depth === 0 && character === target) return index;
  }
  return -1;
}

function stripFullOuterParentheses(rawValue) {
  let value = rawValue.trim();
  while (value.startsWith('(')) {
    const close = findMatchingParenthesis(value, 0);
    if (close !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function splitTopLevelAdd(expression) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth < 0) return null;
    }
    else if (
      depth === 0 &&
      character === '+' &&
      !['e', 'E'].includes(expression[index - 1])
    ) {
      parts.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (inString || depth !== 0) return null;
  parts.push(expression.slice(start).trim());
  return parts;
}

function splitTopLevelOperator(expression, operator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] === '(') depth += 1;
    else if (expression[index] === ')') {
      depth -= 1;
      if (depth < 0) return null;
    }
    else if (depth === 0 && expression.slice(index, index + operator.length) === operator) {
      parts.push(expression.slice(start, index).trim());
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  if (depth !== 0) return null;
  parts.push(expression.slice(start).trim());
  return parts;
}

function splitOutsideStrings(text, separator) {
  const parts = [];
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (text.slice(index, index + separator.length) === separator) {
      parts.push(text.slice(start, index));
      start = index + separator.length;
      index += separator.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function normalizeDisplaySettings(payloadDisplay = {}, options = {}) {
  const display = { ...payloadDisplay, ...options };
  const currency = String(
    display.currency || display.default_currency || 'USD',
  ).toUpperCase();
  if (!DISPLAY_CURRENCIES.has(currency)) return null;
  if (positiveNumber(display.usd_exchange_rate) === null) return null;
  if (
    display.show_with_recharge === true &&
    nonNegativeNumber(display.price) === null
  ) {
    return null;
  }
  return {
    ...display,
    currency,
    custom_currency_exchange_rate:
      positiveNumber(display.custom_currency_exchange_rate) ?? 1,
    custom_currency_symbol:
      String(display.custom_currency_symbol || '').trim() || '¤',
  };
}

function priceItems(pricesUSD, display, tokenUnit) {
  const items = [];
  for (const [key, value] of Object.entries(pricesUSD)) {
    if (value === null) continue;
    const item = displayItem(
      key,
      BILLING_LABEL_BY_FIELD[key] || key,
      value,
      display,
      tokenUnit,
    );
    if (!item) return null;
    items.push(item);
  }
  return items;
}

function displayItem(key, label, usdPrice, display, tokenUnit) {
  const divisor = tokenUnit === 'K' ? 1000 : 1;
  const value = convertPricingDisplayValue({
    usdPrice,
    currency: display.currency,
    priceRate: display.price,
    usdExchangeRate: display.usd_exchange_rate,
    customExchangeRate: display.custom_currency_exchange_rate,
    applyRecharge: display.show_with_recharge === true,
  });
  if (value === null) return null;
  const dividedValue = value / divisor;
  return {
    key,
    label,
    usdPrice,
    value: dividedValue,
    currency: display.currency,
    rechargeApplied: display.show_with_recharge === true,
    formatted: formatMoney(
      dividedValue,
      display.currency,
      display.custom_currency_symbol,
    ),
  };
}

export function formatMoney(value, currency = 'USD', customSymbol = '¤') {
  if (!Number.isFinite(value)) return '—';
  const selectedCurrency = String(currency).toUpperCase();
  const symbol =
    selectedCurrency === 'CNY'
      ? '¥'
      : selectedCurrency === 'CUSTOM'
        ? customSymbol
        : '$';
  const absolute = Math.abs(value);
  const digits = absolute >= 100 ? 2 : absolute >= 1 ? 3 : 4;
  return `${symbol}${value.toFixed(digits)}`;
}

function unavailablePricing(common, kind, code, reason, extra = {}) {
  return {
    ...common,
    kind,
    availability: 'unavailable',
    unavailableCode: code,
    unavailableReason: reason,
    unit: '',
    items: [],
    ...extra,
  };
}

function multiplyOptional(base, multiplier) {
  return isPresent(multiplier) ? base * Number(multiplier) : null;
}

function isPresent(value) {
  return value !== '' && value !== null && value !== undefined;
}

function isNonNegativeFinite(value) {
  return Number.isFinite(value) && value >= 0;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function strictPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function finiteNumber(value) {
  if (!isPresent(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
