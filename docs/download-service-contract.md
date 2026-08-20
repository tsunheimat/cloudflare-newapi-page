# Download Service Binding integration contract

## 只读 source provenance

Phase 2A 只读核对了 sibling checkout `/mnt/vibe-coding-share/tokenrouter/cloudflare-download-site`；本 deployment-ready follow-up 沿用该已提交 snapshot contract，仍不修改或生成 sibling 中任何 tracked/untracked bytes：

- Git commit：`becb3e80dae6e66724b332ebadeb1522cd257d46`
- Wrangler service name：`cloudflare-download-site`
- `src/worker.js` SHA-256：`049eaf446a4e6b078db0872c672e53a5a9c5cf088ca7b7e7319af4cdd124eac1`
- `wrangler.toml` SHA-256：`c7b6ecc6f789331f0bcab2ff976fe0d5cc742fdc13a4e4396f416bef2a4bf504`

这些值只标识本地审查快照，不能证明 Cloudflare 已部署的 `cloudflare-download-site` 对应同一 commit 或 bytes。

## Route surface

所有 route 都可通过 mounted `/downloads/...` 访问；下表的 direct route 也会由 gateway 直接保留，以支持 downstream HTML 的 root-relative link、asset 和 form action。

| Family | Downstream route | Source methods | Gateway mode |
| --- | --- | --- | --- |
| Landing | `/` | GET | mounted `/downloads` |
| Software page | `/software/:software` | GET | direct + mounted |
| Static assets | `/assets/*` | GET | direct + mounted |
| Default metadata | `/api/latest`, `/api/public`, `/api/previous` | GET | direct + mounted |
| Default target metadata | `/api/{latest|public}/:site/:platform/:arch` | GET | direct + mounted |
| Software metadata | `/api/:software/{latest|public|previous}` | GET | direct + mounted |
| Software target metadata | `/api/:software/{latest|public}/:site/:platform/:arch` | GET | direct + mounted |
| Default downloads | `/download/latest/:site/:platform/:arch`, `/download/:site/:platform/:arch` | GET | direct + mounted |
| Software downloads | `/download/:software/latest/:site/:platform/:arch`, `/download/:software/:site/:platform/:arch` | GET | direct + mounted |
| WeChat QR metadata | `/api/wechat-group-qrcode/latest` | GET | direct + mounted |
| WeChat QR image | `/wechat-group-qrcode`, `/wechat-group-qrcode/latest` | GET | direct + mounted |
| Admin page | `/admin` | GET | direct + mounted |
| Admin session | `/admin/login`, `/admin/logout` | POST | direct + mounted |
| Admin QR upload | `/admin/wechat-group-qrcode/upload` | POST multipart | direct + mounted |
| Publish/rollback actions | `/admin/public/:action`, `/admin/:software/public/:action` | POST form | direct + mounted |

Reviewed downstream source 没有显式 HEAD handler；gateway 不把 HEAD 改写成 GET，因此当前 contract 的 downstream HEAD 结果是 404。Phase 2B 会把 HEAD 作为无 mutation 的 method-preservation/drift probe，而不是把它冒充成功的 download health check。

Route matcher 使用完整 path segment。`/administrator`、`/assets-old/*`、`/downloads-old`、`/api/latest-news`、`/api/publicity` 和 `/api/content/*` 不会送到 download Worker。

## Request contract

- Mounted `/downloads` 映射到 downstream `/`；`/downloads/<path>` 映射到 `/<path>`。
- Mounted request 强制设置 `x-forwarded-prefix: /downloads`；direct request 删除客户端传入的同名 header。
- Method、query string、body bytes、`Content-Type`、`Cookie` 与其他 request headers 由 `new Request(downstreamUrl, request)` 保留。
- Gateway 不解析 admin password/session、multipart upload 或 publish/rollback form，也不直接调用 R2。

## Response contract

- 保留 downstream status、body/ReadableStream、binary bytes、`Content-Type`、`Content-Length`、`Content-Disposition`、`ETag`、`Set-Cookie` 与 cache headers。
- `Location` 不改写：transport tests 分别覆盖 relative、root-relative 与 external redirects。Reviewed downstream 当前会为 admin action/session 产生 root-relative 303，为 public R2 URL 产生 external 302；relative case 属于 gateway 通用 contract。
- Downstream CSP 与已有 transport security headers 保持原值。若缺少 `x-content-type-options`、`referrer-policy`、`x-frame-options` 或 `permissions-policy`，gateway 才补默认值。
- 不把本站 SPA 的 `style-src 'self'` CSP 套到 downstream HTML/admin response。

## Status 与 fail-closed

Runtime gate 只接受 `DOWNLOADS_INTEGRATION=staging-service-binding` 或 `production-service-binding`。其他 mode、缺失 binding、非 callable binding 均返回 503。Default config 是 `disabled` 且没有 binding；即使同名 binding 被意外注入，也不会转发。命名 staging/production 各自以独立 gate 绑定同一个 `cloudflare-download-site`。

`configured=true` 表示 runtime 存在 binding property；`bound=true` 表示它具有 callable `fetch`，两者保留 Phase 1 语义。只有允许的命名环境 gate 与 `bound=true` 同时成立才有 `active=true`。即使 active，状态仍是：

```json
{
  "active": true,
  "healthy": null,
  "live": false,
  "phase": "bound-unverified"
}
```

Repository evidence 位于 `test/download-service.test.js`、`test/worker.test.js`、`test/staging-config.test.js` 和 `test/production-deployment.test.js`。它验证 routing/transport/config/deploy guard contract，但不验证 actual Cloudflare binding、deployed sibling bytes、R2 objects、production route 或真实浏览器行为。Production 操作见 [production-deployment.md](production-deployment.md)。
