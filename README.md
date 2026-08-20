# Cloudflare NewAPI Public Page

独立的 Cloudflare Worker 公共站点。第一阶段提供可执行、可测试的 Docs 与 Pricing 基线，不修改 NewAPI backend，也不复制现有 download Worker 的 R2/admin 逻辑。

## 第一阶段已包含

- `/`：公共站点与 integration boundary 概览。
- `/docs/*`：结构化导航、搜索、页内目录、表格、callout 和可复制代码示例。
- `/pricing`：模型筛选、USD/CNY/CUSTOM、充值换算开关与 1M/1K 展示；价格上下文固定为普通用户 `user_group=default`、`selected_group=default`。
- `/api/content/docs`、`/api/content/docs/:slug`：可替换 Docs adapter contract。
- `/api/content/pricing`：保留 NewAPI pricing fields 的 fixture contract。
- `/api/integrations/downloads`：既有下载 Worker service binding 的状态与能力边界。
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

`npm run build` 只执行 `wrangler deploy --dry-run`，不会 deploy。

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

## Live integration 边界

`wrangler.toml` 默认且只启用：

```toml
[vars]
CONTENT_ADAPTER = "fixture"
```

把它改成未知值（包括 `newapi`）会返回 503；本阶段没有 NewAPI URL、Tunnel hostname 或 VPC endpoint，也不会假装已经接通。

既有 `/mnt/vibe-coding-share/tokenrouter/cloudflare-download-site` 仍然单独持有下载、admin session、R2、rollback 和微信群二维码功能。本 repo 只定义 `DOWNLOADS_SERVICE` service binding boundary；本阶段没有在 `wrangler.toml` 实际绑定。未来由 Cloudflare 环境配置：

```toml
[[services]]
binding = "DOWNLOADS_SERVICE"
service = "cloudflare-download-site"
```

保留的转发入口包括 `/downloads/*`、`/software/*`、`/download/*`、`/admin/*`、`/assets/*`、`/wechat-group-qrcode` 及其子路径，以及 download Worker 的公开 metadata API。配置前统一 fail closed 为 503。

状态 API 会分别报告 `configured`、`bound`、`healthy` 与 `live`。Binding object 只足以证明 `bound=true`；Phase 1 不主动探测 downstream，所以 `healthy=null`、`live=false`。Gateway 只在 path segment boundary 命中下载路由，并保留 downstream 自己的 CSP；本 SPA 的 `style-src 'self'` 只应用于本站 assets/API response。

更详细的后续接入条件见 [docs/architecture.md](docs/architecture.md)。

## 明确排除

- 不修改 NewAPI backend。
- 不修改或部署现有 download Worker。
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
