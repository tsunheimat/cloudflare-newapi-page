# Phase 1 架构与 Phase 2 deployment-ready integration

## 组件边界

```text
Browser
  ├─ /docs/*, /pricing ──> Worker Assets (Phase 1 SPA)
  ├─ /api/content/* ─────> ContentAdapter
  │                          └─ FixtureAdapter (Phase 1 only)
  └─ download routes ─────> explicit runtime gate
                               ├─ default: disabled -> 503
                               ├─ staging: staging-service-binding
                               └─ production: production-service-binding
                                    └─ DOWNLOADS_SERVICE
                                         └─ cloudflare-download-site Worker

Future:
  ContentAdapter
    └─ verified NewAPI service-binding/private connectivity adapter
```

`ContentAdapter` 是唯一可替换资料边界。UI 不读取硬编码的 NewAPI hostname，也不直接访问 private/VPC/Tunnel。Fixture 和 future live adapter 必须返回同一个 public display contract。

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

Phase 1 renderer 支持 `lead`、`paragraph`、`heading`、`callout`、`code`、`bullets`、`endpoint`、`table` 和 `link-cards`。Live adapter 接入前，需要确认 NewAPI Docs 的公开 page/revision/navigation/assets/search contract，再决定是逐块投影还是增加受版本控制的 renderer contract。不得从 private Admin response 直接透传内部字段。

## Pricing contract 与不变量

Pricing response 保留 NewAPI `/api/pricing` 的主要字段：`data`、`vendors`、`group_ratio`、`usable_group`、`supported_endpoint`、`auto_groups`、`video_resolution_dimensions` 和 `pricing_version`，并增加 public page 的 `meta`、`context` 与 display settings。

Public adapter 必须强制：

```text
context.user_group      = default
context.selected_group  = default
context.locked          = true
group_ratio.default     exists and is finite/non-negative
usable_group.default    exists
```

模型可见性沿用 NewAPI group 规则：空 `enable_groups`、`all` 或包含 `default` 才可在普通用户页面显示。`billing_mode` 是 `tiered_expr` 与 `video` 的优先判别字段，不能被 legacy `quota_type` 覆盖。

Versioned tiered display contract 目前只接受 NewAPI v1 的完整静态单位价格子集：`tier(name, p * price + c * price + ...)`、`p/c/len` 档位条件、完整 v1 variable registry，以及 `|||when(...) * multiplier` 请求规则后缀。任何未覆盖的有效 backend expression 也必须显示为不可计算；public Worker 不会执行 provider request function、取局部 regex 命中或把第一档投影成最终价格。

Video display contract 会保存 `video_pricing.currency` 来源币种，先将 CNY/USD rate 正规化为 USD，再应用真实的 `group_ratio.default`，最后与所有其他 pricing card 共用充值与 USD/CNY/CUSTOM conversion。一个 resolution row 缺少必要字段会使整份 video profile 不可计算，不会用剩余 row 产生起价。

Future live adapter 还需要原样保留结构化 video pricing、capability、route contract、input-duration policy 和 billing expression；不支持的新版 contract 必须 fail closed 或明确显示不可计算，不能取第一项、最低价或 legacy 字段自行猜测。

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

## NewAPI live adapter 后续门槛

在切换 `CONTENT_ADAPTER` 前至少需要：

1. 明确 Cloudflare Worker 到 private NewAPI 的授权 transport（service binding、Tunnel/private network 等）与 owner。
2. 当前部署的 NewAPI public Docs/Pricing response 样本和版本标识。
3. 普通匿名/普通用户身份如何稳定解析为 `user_group=default`，以及 `selected_group=default` 如何传递。
4. Docs navigation/page/assets/search 与 Pricing/status/exchange-rate 的完整字段映射和数据最小化审查。
5. timeout、cache/stale、schema drift、partial failure 和 rollback policy。
6. staging 端到端验收；页面上的 live badge 只能由已验证 adapter 明确产生。

当前 artifact 不包含任何 hostname、credential、Tunnel ID、service token 或 live data mutation。

Phase 2 的 local/mock 与 Wrangler dry-run 不能证明实际 Cloudflare account 已存在该 binding、deployed target 与只读 source snapshot 相同、R2 objects 可用或 production routing 已完成。
