# Cloudflare NewAPI Public Page

独立的 Cloudflare Worker 公共站点。Phase 1 提供可执行、可测试的 Docs 与 Pricing 基线；Phase 2A 增加仅限 staging 的既有 download Worker Service Binding 配置与 repository-owned integration contract。两个阶段都不修改 NewAPI backend，也不复制 download Worker 的 R2/admin 逻辑。

## 已包含

- `/`：公共站点与 integration boundary 概览。
- `/docs/*`：结构化导航、搜索、页内目录、表格、callout 和可复制代码示例。
- `/pricing`：模型筛选、USD/CNY/CUSTOM、充值换算开关与 1M/1K 展示；价格上下文固定为普通用户 `user_group=default`、`selected_group=default`。
- `/api/content/docs`、`/api/content/docs/:slug`：可替换 Docs adapter contract。
- `/api/content/pricing`：保留 NewAPI pricing fields 的 fixture contract。
- `/api/integrations/downloads`：既有下载 Worker Service Binding 的状态、route mode 与能力边界。
- Worker security headers、API fail-closed 行为与 SPA asset fallback。

所有 fixture 内容在 API 和 UI 都明确标记为演示数据，不代表 live NewAPI、provider 能力或生产报价。

## 本地运行

需要 Node.js 22.0.0 或更新版本。锁定的 Wrangler 4.124.0 同样要求 Node.js `>=22.0.0`；`.npmrc` 会执行 engine-strict 检查并固定使用公开 npm registry。

```bash
npm ci
npm run dev
```

Wrangler 会输出本地 URL。直接访问：

```text
/docs/quickstart
/pricing
/api/health
```

完整本地验证：

```bash
npm run validate
```

`npm run validate` 会分别执行 default、staging、production 三条 `wrangler deploy --dry-run` lane，不会 deploy。也可单独执行：

```bash
npm run build
npm run build:staging
npm run build:production
```

## Pricing 产品语义

第一阶段不提供 group selector。`src/adapters/content-adapter.js` 和浏览器端 `public/static/pricing.js` 都会检查：

```json
{
  "user_group": "default",
  "selected_group": "default",
  "locked": true
}
```

当前展示和计算分支与已核对的 NewAPI 行为保持一致：

- 普通按量：`model_ratio × 2 × default group ratio` 得到 USD / 1M 输入 tokens；输出、缓存、图片和音频再乘对应 ratio。
- 按次：`model_price × default group ratio`。
- `billing_mode=tiered_expr` 优先于 legacy `quota_type`。Versioned v1 parser 的变量 registry 与 NewAPI 对齐为 `p`、`c`、`cr`、`cc`、`cc1h`、`img`、`img_o`、`ai`、`ao`；价格项采用 `p * 3 + c * 15` 语法，并保留 `|||when(...) * multiplier` 请求规则后缀。
- 动态表达式必须整段解析成功；未知版本、未知字段、任一损坏档位或请求规则都会把该模型明确标记为不可计算，不会保留部分价格，也不会回退到 legacy 字段。即使全部档位可解析，页面也不会把第一档冒充没有请求上下文的最终价格。
- `billing_mode=video` 只在完整的 version 1 `video_pricing` 存在时生效；每一个分辨率都必须同时包含有/无输入视频价格。来源 CNY/USD 先正规化成 USD，再应用真实 default group ratio，之后与普通价格共用充值及 USD/CNY/CUSTOM 显示换算。
- 充值价格和所有卡片、动态档位、影片详情矩阵共用 `price`、`usd_exchange_rate`、`custom_currency_exchange_rate` 的换算顺序。

Fixture 数字只验证以上路径。未来 adapter 必须投影 NewAPI 的公开价格 response，而不是建立另一套价格表。

## Phase 2A staging download integration

Wrangler environment 的 bindings 与 vars 不会自动继承。Repository 明确配置：

```toml
[vars]
CONTENT_ADAPTER = "fixture"
DOWNLOADS_INTEGRATION = "disabled"

[env.staging.vars]
CONTENT_ADAPTER = "fixture"
DOWNLOADS_INTEGRATION = "staging-service-binding"

[[env.staging.services]]
binding = "DOWNLOADS_SERVICE"
service = "cloudflare-download-site"

[env.production.vars]
CONTENT_ADAPTER = "fixture"
DOWNLOADS_INTEGRATION = "disabled"
```

只有 staging 同时具有显式 runtime gate 与 callable binding 时才会转发。Default 与 production 都没有 `DOWNLOADS_SERVICE` 配置且 gate 为 `disabled`；即使运行环境意外注入同名 binding，也不会启用下载转发。未知 mode、缺失或无效 binding 全部返回 503。

既有 `/mnt/vibe-coding-share/tokenrouter/cloudflare-download-site` 仍然单独持有下载、admin session、R2、rollback 和微信群二维码功能。本 repo 只负责 HTTP forwarding boundary。保留的入口包括：

- mounted `/downloads` 与 `/downloads/*`，转发时移除 `/downloads` 并设置可信的 `x-forwarded-prefix: /downloads`；
- direct `/software/*`、`/download/*`、`/admin/*`、`/assets/*`、`/wechat-group-qrcode*`；
- default、software-specific 与微信群二维码 public metadata API。

Gateway 保留 method、body bytes、query、cookie、content type、binary response stream、status、redirect 与 downstream headers；direct route 会删除不可信的 incoming `x-forwarded-prefix`。Gateway 只在 path segment boundary 命中下载路由，并保留下游自己的 CSP；本 SPA 的 `style-src 'self'` 只应用于本站 assets/API response。

状态 API 会分别报告 `configured`、`bound`、`active`、`healthy` 与 `live`。`configured`/`bound` 保留 Phase 1 的 binding present/callable 语义；只有 staging gate 与 callable binding 同时成立才有 `active=true`。Active binding 仍固定为 `healthy=null`、`live=false`、`phase=bound-unverified`，不得冒充 live verification。

完整 source snapshot、route/response contract 和本地测试范围见 [download-service-contract.md](docs/download-service-contract.md)。需要最小权限 Cloudflare auth 的实际 binding 验证留给 [Phase 2B read-only remote probe](docs/phase-2b-remote-probe.md)。本次 Phase 2A 没有执行 login、remote dev、Cloudflare/R2 mutation、push 或 deployment。

## NewAPI live integration 边界

`CONTENT_ADAPTER` 在所有环境仍是 `fixture`。把它改成未知值（包括 `newapi`）会返回 503；本阶段没有 NewAPI URL、Tunnel hostname 或 VPC endpoint，也不会假装已经接通。

## 明确排除

- 不修改 NewAPI backend。
- 不修改或部署现有 download Worker。
- 不把 local mock、dry-run 或 config parsing 当成 actual Cloudflare Service Binding/R2/live 证据。
- 不执行 Cloudflare deploy、R2 mutation、Tunnel/VPC 设置或 DNS mutation。
- 不保存 API token、Cloudflare credential、R2 credential 或 admin secret。
- 不把 fixture、schema acceptance 或页面显示当成 live capability proof。

## 可重复工具链

`package-lock.json` 只包含 `https://registry.npmjs.org` artifact URL，不包含内部 registry hostname 或 credential。可用干净安装目录验证：

```bash
npm ci
npm run validate
```

这只验证本地依赖、测试和 Wrangler dry-run，不验证 live Cloudflare、NewAPI、download Worker、Tunnel/VPC 或 R2。
