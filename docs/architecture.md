# Phase 1 架构与 Phase 2 deployment-ready integration

## 组件边界

```text
Browser
  ├─ /docs/*, /console/pricing, /pricing ──> Worker Assets (canonical SPA surfaces)
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
    └─ `/api/pricing` (compatibility alias: `/api/content/pricing`)
         └─ ContentAdapter -> NEWAPI_VPC_SERVICE -> `/api/internal/live-content/v1/pricing`

Public canonical DocsHub:
  Browser (credentials omitted by the canonical DocsHub transport)
    └─ `/api/docs/v2/*` (config, spaces, tree, navigation, pages, search, assets, …)
         └─ NEWAPI_VPC_SERVICE + LIVE_CONTENT_ADAPTER_TOKEN
              -> `/api/internal/live-content/v1/docs/v2/*`

Public canonical bootstrap:
  `/api/status` (read-only, fixed token-only GET)
         └─ NEWAPI_VPC_SERVICE -> `/api/internal/live-content/v1/status`
```

The public `/api/docs/v2/*` routes are same-origin adapters for the canonical
NewAPI DocsHub. The Worker constructs fixed GETs over the VPC binding and
forwards only `Accept`, the Worker token Authorization header, and an optional
`If-None-Match` validator. Browser cookies, `New-Api-User`, browser
Authorization, API keys, provider/admin credentials, arbitrary headers, and
end-user logic are not inspected or forwarded. Published normal/public pages
and enabled navigation groups retain the canonical recursive folder/layer/page
DTOs; unknown credential-shaped fields are redacted and malformed responses,
timeouts, or oversized bodies fail closed. `public/static/docs-hub.*` is built
from the approved NewAPI `web/src/pages/DocsHub` and `packages/docs-core`
sources, preserving the original layout, strings, reader, search, TOC,
navigation, and block rendering behavior.

`/console/pricing` and `/pricing` mount the same canonical React SPA runtime.
Its canonical bundle bootstraps through the public same-origin `/api/status`
route and calls `/api/pricing`; both paths are fresh, same-origin, and
explicitly disable browser credentials and secure-API signing. The status
route performs a bounded fixed token-only GET through `NEWAPI_VPC_SERVICE`,
forwards no browser headers or credentials, and exposes only the dedicated
backend display/conversion bootstrap fields. The live pricing adapter returns
the canonical backend body byte-for-byte: it does not sort arrays, filter
identifiers, reconstruct maps, fabricate context, or rewrite future fields.
Schema drift, timeout, oversized bodies, and upstream errors fail closed. The
Worker never manufactures display settings, exchange rates, recharge behavior,
or group ratios from localStorage or browser identity.

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

Pricing response is the exact body from NewAPI's dedicated-token
`/api/internal/live-content/v1/pricing`, which delegates to canonical
`/api/pricing`. All groups (including names with spaces), ratios, vendor/model
ordering, endpoint/capability maps, auto groups, video dimensions, pricing
version, and future public fields remain unchanged. The Worker does not add a
context or display object and does not compute prices.

The canonical bundle retains NewAPI's supplier/group/list, table/card, filter,
detail-sheet, billing, conversion, and capability presentation. Those browser
calculations consume the exact Pricing and status bootstrap values; the Worker
does not duplicate them or impose a locked/default group.

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
