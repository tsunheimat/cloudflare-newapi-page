# Phase 2B read-only remote Service Binding probe

Phase 2B 的目标是在 Cloudflare temporary remote preview 中验证 staging
candidate 的 NewAPI-owned Downloads R2 authority。旧的 `DOWNLOADS_SERVICE`
仍可作为 rollback binding，但迁移后的请求不应调用它。Probe 的 HTTP
methods 仅限 GET/HEAD，不执行 admin POST，不携带 admin cookie，不 follow
redirects，也不 deploy production Worker。

Cloudflare 官方说明：Wrangler environment 的 vars/bindings 不继承；remote development 会把 candidate 暂时上传到 Cloudflare preview，并让 bindings 连接 remote resources。Service Binding HTTP 调用会直接调用目标 Worker 的 `fetch()`。因此 remote preview 是实际 integration evidence，但仍不是 production deployment evidence。

参考：

- [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)
- [Service Bindings HTTP interface](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)
- [Local and remote development](https://developers.cloudflare.com/workers/local-development/)

## Authority boundary

Remote preview 需要上传 temporary Worker code，所以严格的 read-only Cloudflare token 不足以启动它。这里的“read-only”指 probe 的 downstream HTTP/R2 behavior，不代表 token 权限是 read-only。

由 Cloudflare owner 创建短时、单 account、可选 IP-restricted token，只授予 Wrangler remote preview 所需的 Workers script edit、`Connectivity Directory Bind`（读取、列出并绑定既有 VPC Service）与不可避免的 identity/account read 权限。不要授予 Connectivity Directory Admin、R2 Storage Edit、DNS Edit、Workers Routes Edit、Tunnel/VPC Admin 或其他资源 mutation 权限。Token 仍可能具备修改 Worker script 的能力，因此必须短 TTL、运行后立即撤销，并由 operator 严格只执行本 runbook 中的 `wrangler dev --remote`；不得执行 `wrangler deploy`。

Credential 只通过当前 shell 的 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 提供，不写入 repository、`.env`、`.dev.vars`、shell history、日志或 probe output。若 Wrangler 报告缺少权限，停止并由 owner 审核；不要自行扩大 scope。

## 执行前

1. 核对 candidate commit、branch 与 clean worktree。
2. 在 Node 22+ 环境执行 `npm ci` 与 `npm run validate`。
3. 由 owner 在当前 shell 注入 short-lived credential，再执行 `npx wrangler whoami` 确认 account。不要走 interactive login。
4. 确认 `wrangler.toml` 中 `env.staging.services` 与 `env.production.services` 都指向 `cloudflare-download-site`；default 仍 disabled，且本 preview command 固定选择 staging。

本 Phase 2A 主机没有 credential，以上 remote 步骤均未执行。

`npm run test:browser` 中的 Downloads cases 使用 Playwright route mocks，只是 `[mocked/source evidence]`，用于验证 SPA rendering、credential isolation 与 link construction；它们不替代下面的 remote Service Binding probe，也不证明真实 catalog、metadata、redirect 或 R2 target。

## 启动 temporary preview

在第一个 shell：

```bash
npm run phase2b:remote
```

该命令固定使用 `--env staging`、`--remote`、`127.0.0.1:8787`。Remote preview URL 必须保持 loopback；不要暴露到 LAN 或 public hostname。

在第二个 shell：

```bash
PHASE2B_PREVIEW_URL=http://127.0.0.1:8787 npm run phase2b:probe
```

Probe script 有以下硬边界：

- 拒绝 non-loopback base URL；
- 只允许 GET/HEAD，`credentials: omit`；
- `redirect: manual`，不会跟随 R2/external redirect；
- 只对 `/admin` 做匿名 GET，不请求 login、不发送 cookie、不调用任何 admin action/upload；
- exact GET `/downloads` 与 `/downloads/software/:softwareId` 必须返回 JuAPI workspace document markers（`JuAPI 开发者中心`、`main#main-content` 与 `/static/app.js`）；实际软件 groups/detail 内容在同一 document 的 Downloads panel 中由 catalog 与 R2 metadata 读取；
- 先 GET `/api/downloads/catalog`，校验每个发现的 software ID 与 SPA href，再逐一 GET `/downloads/api/:softwareId/public`；若某个 public metadata 明确返回 404，才对同一 ID GET `/downloads/api/:softwareId/latest`；
- 从发现的 metadata 选择一个带 `site`、`platform`、`arch` 的代表 target，验证 `/downloads/download/:softwareId/:site/:platform/:arch` 与 direct `/download/...` 路由。若 download Worker 返回 direct binary stream，script 只检查 headers 后立即 cancel body，不下载大 artifact；这仍属于实际 R2 read，必须计入 read-operation/billing budget；
- 检查 health/status 为 `active=true`，但仍是 `healthy=null`、`live=false`、`bound-unverified`，避免把 R2 binding presence 冒充 health。

The migrated route has no explicit HEAD handler; public/download HEAD 预期 404。该结果证明 method 被保留，不表示 GET route unhealthy；若实际结果不同，应记录 deployed-source drift 后重新审查，不要自行放宽 assertions。

## 完成与证据

1. 保存 stdout JSON lines、candidate commit、Wrangler version、account identifier、开始/结束时间和 probe exit code；不要保存 token、cookie、metadata body、signed URL 或完整 external `Location`。
2. `Ctrl-C` 停止 remote preview，确认 Wrangler session 结束。
3. 立即撤销 temporary token，并从 shell unset credential。
4. 再次确认 repository clean；不得 commit probe output。

Phase 2B PASS 可以证明“该 exact candidate 的 staging temporary remote preview 在该时刻通过 actual Service Binding 完成限定 GET/HEAD 与 catalog-to-metadata-to-download probe”。它不能证明 production config 已实际部署、default 已启用（default 本就应保持 disabled）、deployed download Worker 与本地 sibling commit 相同、所有 R2 artifacts 完整，或 admin mutation flow 可用。没有实际运行 stdout、exit code 与时间戳时，不得声称 remote success。
