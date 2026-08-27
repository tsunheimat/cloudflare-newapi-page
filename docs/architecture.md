# Phase 1 架构与 Phase 2 deployment-ready integration

## 组件边界

```text
Browser
  ├─ /, /docs/*, /console/docs/*, /console/pricing, /pricing, /downloads, /downloads/software/* ──> one Worker Assets workspace shell
  │      └─ persistent Home / Docs / Pricing / Downloads panels
  ├─ Downloads APIs, direct targets, /admin/* ─────────> Worker Downloads R2 authority / rollback binding
  ├─ /api/content/* ─────> ContentAdapter
  │                          └─ FixtureAdapter (Phase 1 only)
  └─ download routes ─────> `DOWNLOADS` (tokenrouter R2 bucket)

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

Public Downloads:
  `/downloads` and `/downloads/software/:softwareId` -> the shared workspace shell
       └─ `/api/downloads/catalog` -> fixed two-profile registry projection
       └─ `/downloads/api/:softwareId/public` -> R2 metadata object
       └─ `/downloads/download/:softwareId/:site/:platform/:arch` -> R2 redirect/stream

The route implementation preserves the existing metadata/state object model,
public URL precedence, lock state, admin session, redirect resolution, and QR
upload behavior. It never forwards browser credentials into a private service.
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
navigation, and block rendering behavior. Validated public Docs V2 JSON `200`
responses may be stored in the disposable Worker Cache API for 60 seconds at
the edge with a 300-second stale-while-revalidate window. URL-only keys retain
the complete safe route/query dimensions and never contain browser or Worker
credentials; cache errors do not alter the VPC fail-closed path, and NewAPI
remains the only mutable content authority.

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

## Downloads R2 authority

The NewAPI Worker owns the direct and mounted Downloads route families and
reads/writes the existing `DOWNLOADS` R2 bucket. It preserves the source
metadata/state layout, dynamic release selection, public URL precedence,
rollback projections, admin session signing, QR validation/upload, binary
streaming, and response redirects. Browser cookies, authorization headers, and
end-user identity are not forwarded to a private service. Missing R2 binding
fails closed for the migrated path.

The old `DOWNLOADS_SERVICE -> cloudflare-download-site` binding remains
declared in the named environments solely as a rollback path. If the R2
binding is present, migrated routes do not call it; the old transport tests and
read-only probes remain useful evidence for rollback only.

The Worker adds transport security headers to migrated responses while keeping
the Downloads HTML contract intact. Status reports R2 binding presence,
callability, and unverified live state separately. Local tests use an in-memory
R2 double; Wrangler dry-runs do not prove the production bucket, objects, or
Cloudflare route acceptance.

Staging remote closure 可用 Phase 2B temporary preview 执行 GET/HEAD-only probe，检查 shared workspace document、动态 catalog IDs、每个 discovered public/latest metadata、representative mounted/direct download routing、redirect 与 content type。Production 则只能经 fail-closed entrypoint 部署并按 runbook 执行同一条真实 catalog chain GET probe。Browser Playwright Downloads cases 明确是 `[mocked/source evidence]`；两者都不得把 mock、dry-run 或缺少实际 stdout 当成 remote/live evidence；详见 [phase-2b-remote-probe.md](phase-2b-remote-probe.md) 与 [production-deployment.md](production-deployment.md)。

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
