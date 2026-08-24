# Phase 1 架构与 Phase 2 deployment-ready integration

## 组件边界

```text
Browser
  ├─ /docs/*, /console/pricing, /pricing ──> Worker Assets (Phase 1 SPA)
  ├─ /api/content/* ─────> ContentAdapter
  │                          └─ FixtureAdapter (Phase 1 only)
  └─ download routes ─────> explicit runtime gate
                               ├─ default: disabled -> 503
                               ├─ staging: staging-service-binding
                               └─ production: production-service-binding
                                    └─ DOWNLOADS_SERVICE
                                         └─ cloudflare-download-site Worker

Future/live:
  ContentAdapter
    ├─ FixtureAdapter (default safety mode)
    └─ NewAPI live adapter (explicit `CONTENT_ADAPTER="newapi"`)
         └─ NEWAPI_VPC_SERVICE -> newapi-api.newapi:3000

Public Pricing:
  Browser (no session or user auth)
    └─ `/api/content/pricing`
         └─ ContentAdapter -> NEWAPI_VPC_SERVICE -> `/api/internal/live-content/v1/pricing`

Public recursive Docs navigation:
  Browser (credentials omitted by the SPA)
    └─ `/api/front-door/v1/docs/v2/navigation?locale=zh`
         └─ NEWAPI_VPC_SERVICE + LIVE_CONTENT_ADAPTER_TOKEN
              -> `/api/internal/live-content/v1/docs/v2/navigation?locale=zh`

Public canonical bootstrap:
  `/api/status` (read-only, fixed anonymous GET)
         └─ NEWAPI_VPC_SERVICE -> canonical NewAPI `/api/status`
```

The recursive Docs route is a public compatibility URL backed only by the
Worker-held service token. The Worker constructs a fixed GET over the VPC
binding and forwards only `Accept`, the Worker token Authorization header, and
an optional `If-None-Match` validator. Browser cookies, `New-Api-User`, browser
Authorization, API keys, provider/admin credentials, arbitrary headers, and
end-user logic are not inspected or forwarded. Published normal/public pages
and enabled navigation groups are validated and reconstructed through an
explicit bounded public projection that preserves recursive folder/layer/page
`children` and canonical `path`; unknown/private fields are dropped and
malformed known fields fail closed. The sidebar renders that tree recursively,
including nested page descendants. Upstream navigation failure, schema drift,
timeout, or oversized response fails closed. Pricing does not use this route;
the existing service-token live adapter remains the sole public Pricing path.

`/console/pricing` is the public canonical React SPA route; `/pricing` remains a
Worker fixture compatibility alias. Its canonical bundle bootstraps through the
public same-origin `/api/status` route and then calls `/api/content/pricing`.
Pricing calls are fresh, same-origin, and explicitly disable credentials and
secure-API signing. The status route performs a bounded fixed anonymous GET
through `NEWAPI_VPC_SERVICE`, forwards no browser headers or credentials, emits
only bounded safe display/bootstrap fields, and always sets
`secure_api_enabled=false` without exposing key material or signing windows.
Schema drift, timeout, oversized bodies, and upstream errors fail closed. The
Worker never manufactures display settings from localStorage or varies Pricing
with cookies, sessions, or browser identity.

`ContentAdapter` 是唯一可替换资料边界。UI 不读取硬编码的 NewAPI hostname，也不直接访问 private/VPC/Tunnel。Fixture 和 live adapter 必须返回同一个 public display contract。Live adapter 的 secret、schema、failure 和 cutover contract 见 [live-content-adapter.md](live-content-adapter.md)。

## Docs contract

Catalog：

```js
{
  meta: { source, fixture, live, label, updated_at },
  sections: [{
    title,
    items: [{ slug, title, summary, keywords }]
  }]
}
```

Page：

```js
{
  meta,
  page: {
    slug,
    title,
    summary,
    section,
    keywords,
    updated_at,
    blocks
  }
}
```

Fixture renderer 支持 `lead`、`paragraph`、`heading`、`callout`、`code`、`bullets`、`endpoint`、`table` 和 `link-cards`。Docs presentation 的 source authority 是 approved NewAPI commit `85143bc49260f9c7ab1efd6a5122558e58d0bee2`；the token-only public navigation response preserves and renders recursive folder/page layers. Live adapter 对 NewAPI v1 renderer 做同样的受控 projection，未知 block/schema 会 fail closed，不从 private Admin response 直接透传内部字段。

## Pricing contract 与不变量

Pricing response 保留 NewAPI dedicated-token `/api/internal/live-content/v1/pricing` 的主要字段：`data`、`vendors`、`group_ratio`、`usable_group`、`supported_endpoint`、`auto_groups`、`video_resolution_dimensions` 和 `pricing_version`，并保留 canonical `context`、`display` 与 `meta` fields. The public output is the existing ContentAdapter projection; there is no front-door Pricing output or browser-session context.

`/api/content/pricing` 的 fixture/internal-live adapter 必须强制 locked
ordinary-user presentation context supplied by NewAPI's dedicated-token endpoint. 只接受 NewAPI
上游提供的公开 group ratios：每一个 ratio 都必须是 finite、non-negative
number。适配器保留 NewAPI 的 group ratios 原值（包括 `default` 和其他公开
groups），不得 hard-code 任何 ratio 或其他数值，也不得 normalize、clamp、
substitute、fabricate 或以其他方式改写 ratio。这个 adapter move 不重写
NewAPI 的 pricing logic：

```text
content.context.user_group       = default
content.context.selected_group   = default
content.context.locked           = true
group_ratio.default              = finite non-negative upstream default value
group_ratio.*                    = NewAPI upstream public map unchanged
usable_group.selected            exists
```

Pricing presentation 同样复用 pinned NewAPI 的供应商 → 分组 → 价格清单、计价规则、table/card、filter 与 detail-sheet hierarchy。Locked public/default context 只渲染一个 disabled group card；供应商、计费类型、端点、标签、货币、单位与 recharge display 继续使用 canonical payload。

价格模式仍遵循 NewAPI 的 `resolvePricingContext`：`official` 使用
`usedGroupRatio=1` 和原始美元基础价，`group` 使用当前 selected group 的
upstream ratio（locked content adapter 的 selected group 是 `default`）。这个
effective ratio 同时用于普通、按次、tiered、Codex Fast 和 video 分支；不会把
任何 group ratio 套到 official 模式，也不会引入固定倍率。

模型可见性沿用 NewAPI group 规则：空 `enable_groups`、`all` 或包含当前 selected group 才可显示。`billing_mode` 是 `tiered_expr`、`codex_fast` 与 `video` 的优先判别字段，不能被 legacy `quota_type` 覆盖。

Versioned tiered display contract 目前只接受 NewAPI v1 的完整静态单位价格子集：`tier(name, p * price + c * price + ...)`、`p/c/len` 档位条件、完整 v1 variable registry，以及 `|||when(...) * multiplier` 请求规则后缀。任何未覆盖的有效 backend expression 也必须显示为不可计算；public Worker 不会执行 provider request function、取局部 regex 命中或把第一档投影成最终价格。

Video display contract 会保存 `video_pricing.currency` 来源币种，先将 CNY/USD rate 正规化为 USD，再应用真实的 selected group ratio，最后与所有其他 pricing card 共用充值与 USD/CNY/CUSTOM conversion。一个 resolution row 缺少必要字段会使整份 video profile 不可计算，不会用剩余 row 产生起价。

Live adapter 保留结构化 video pricing、capability、route contract、input-duration policy 和 billing expression；Worker 只验证/转发公开 payload，不执行 billing expression。新版或不支持的 contract 必须 fail closed 或由现有页面明确显示不可计算，不能取第一项、最低价或 legacy 字段自行猜测。

Model projection explicitly retains the current public NewAPI row contract:
presentation (`model_name`, `description`, `icon`, `tags`, `vendor_id`,
`owner_by`), image/video flags, quota and all legacy ratios, group and endpoint
capabilities (`enable_groups`, `supported_endpoint_types`, `endpoint_map`),
`billing_mode`/`billing_expr`, `video_pricing`, Fast profile/base model, video
geometry/route/input-duration contracts, `video_capability`, and row
`pricing_version`. Nested maps and capability objects use field allowlists plus
bounded identifier arrays, finite numeric values, dimensions, media modes and
serialized-request/image limits. Unknown or secret-like keys are dropped, and
the complete projected payload is canonicalized for the stable pricing ETag.

## Download service binding

`DOWNLOADS_SERVICE` 只做 Worker-to-Worker transport。它不在本 repo 中：

- 读取或写入 R2；
- 实作 admin login/session；
- 决定 release/public/previous；
- 执行 rollback；
- 上传或保存微信群二维码；
- 保存任何相关 secret。

当前 gateway 会保留 method、原始 body bytes、query、cookie 和 content type，并把 `/downloads/...` 去掉 namespace 后传给 bound Worker；download Worker 原有的 `/software`、`/download`、`/admin`、assets、QR 和 metadata route 也有 direct boundary。Mounted request 会覆盖 `x-forwarded-prefix=/downloads`，direct request 会删除客户端伪造的该 header。Response 保留 body stream、status、content type、content length/disposition、cookies、redirect 和 downstream-owned headers。

Gateway route matcher 要求完整 path segment，`/administrator`、`/api/latest-news` 不属于 download Worker。本站 SPA/API 使用严格的 `style-src 'self'` CSP；downstream response 保留自己的 CSP（或保持无 CSP），只补上缺少且与内容无关的安全 headers，避免破坏既有 inline-style HTML/admin response。状态中的 `configured`、`bound`、`active`、`healthy`、`live` 分开报告；binding 存在不等于 gate 已启用、downstream 已健康或已完成 production 验证。

Phase 2 在 `env.staging` 与 `env.production` 都明确绑定 `DOWNLOADS_SERVICE -> cloudflare-download-site`，并分别以 `staging-service-binding`、`production-service-binding` gate 启用。Default/top-level 仍明确为 `disabled` 且没有 service binding。Repository tests 会验证配置隔离以及完整 forwarding contract；三条普通 Wrangler lane 都只执行 dry-run。

`/downloads` 下游 HTML 使用 root-relative links/assets/forms，因此它们会落入本站保留的 direct boundary。Gateway 不做 HTML string rewrite。Service binding 本身也不等于浏览器侧 admin authorization；admin session 仍完全由 downstream Worker 持有。

Staging remote closure 可用 Phase 2B temporary preview 执行 GET/HEAD-only probe，检查真实 Service Binding、public metadata、redirect 与 content type。Production 则只能经 fail-closed entrypoint 部署并按 runbook 做 GET verification。两者都不得把 mock/dry-run 当成 remote evidence；详见 [phase-2b-remote-probe.md](phase-2b-remote-probe.md) 与 [production-deployment.md](production-deployment.md)。

## NewAPI live adapter cutover gates

production named environment 已按授权切到 `newapi`；top-level 与 staging 仍保持 fixture。任何后续 live 变更至少需要：

1. 明确 Cloudflare Worker 到 private NewAPI 的授权 transport（service binding、Tunnel/private network 等）与 owner。
2. 当前部署的 NewAPI private live Docs/Pricing response 样本和 v1 版本标识。
3. 普通匿名/普通用户身份如何稳定解析为 `user_group=default`，以及 `selected_group=default` 如何传递。
4. Docs navigation/page/search 与 Pricing/status/exchange-rate 的完整字段映射和数据最小化审查。
5. Worker timeout/body/schema failure 和 rollback policy 已由 focused tests 覆盖；任何 stale-cache policy 需由 operator 单独批准。
6. staging 端到端验收；页面上的 live badge 只能由已验证 adapter 明确产生。

当前 artifact 只包含已核对的 private service host/port 与 VPC service ID，不包含任何 secret value、Tunnel mutation、credential 或 live data mutation。production live cutover 的 guarded deployment 与 verification 见 [production-deployment.md](production-deployment.md) 和 [live-content-adapter.md](live-content-adapter.md)。

Phase 2 的 local/mock 与 Wrangler dry-run 不能证明实际 Cloudflare account 已存在该 binding、deployed target 与只读 source snapshot 相同、R2 objects 可用或 production routing 已完成。
