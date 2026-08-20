# Production deployment runbook

本 runbook 部署命名环境 `production`，Cloudflare Worker 名称预计为 `cloudflare-newapi-page-production`。Repository 的唯一实际部署入口是 `npm run deploy:production`；不要直接执行 `wrangler deploy`，也不要用 `CLOUDFLARE_ENV`、额外 CLI 参数或另一份 config 绕过入口。

## 1. 权限与资源前置条件

使用短时、限定单一目标 account（可再限制 TTL/IP）的 custom API token。此 Worker 只使用 Workers Static Assets、明文 config vars 与 Service Binding；在显式提供 `CLOUDFLARE_ACCOUNT_ID`、account 已有 workers.dev subdomain、且不管理 zone route 的前提下，最小权限是：

- Account / Workers Scripts / Edit。

Cloudflare 的 Worker upload API 把 `Workers Scripts Write` 列为所需权限；Dashboard custom token 中对应 `Workers Scripts / Edit`。本配置没有 zone route、KV、D1、R2、DNS、Tunnel/VPC 或 Secrets Store binding，因此不要授予 Account Settings Edit、Workers Routes Edit、Workers KV/R2 Storage Edit、DNS Edit、Tunnel/VPC 或 account-wide unrestricted 权限。若当前 Wrangler/组织策略返回明确的缺权错误，停止并由 account owner 审核；不要自行扩大 token scope。参考 [Worker upload API permission](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/update/)。

Production entrypoint 要求 `CLOUDFLARE_ACCOUNT_ID` 与 `CLOUDFLARE_API_TOKEN` 只存在于当前 process environment。不要写入 repository、`.env*`、`.dev.vars*`、shell history、构建日志或 commit。官方 credential 与 CI 说明：

- [Wrangler system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)
- [External CI/CD authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/gitlab-cicd/)

资源还必须满足：

1. `CLOUDFLARE_ACCOUNT_ID` 指向准备部署 caller Worker 的 account，且该 account 已有可用的 `workers.dev` subdomain。
2. 名为 `cloudflare-download-site` 的 target Worker 已先部署在同一 account。Cloudflare Service Binding 只能绑定本 account 的 Worker，且 target 必须先于 caller 存在；本 repo 不创建或部署 target。见 [Service Bindings deployment](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#deployment)。
3. Account owner 已确认 deployed target 的生产语义与本 repo 审查的 transport contract 相容。Local sibling commit/hash 不是 deployed-source 证明。
4. Operator 已明确 production URL 的访问控制。Service Binding 不提供浏览器侧 admin authorization；`/admin/*` 的 session/auth 仍由 downstream Worker 负责。

Local preflight 与 `wrangler deploy --dry-run` 不会查询已部署 target 是否存在，也不会证明 binding、R2 objects 或 production route 可用。实际 deployment request 才会由 Cloudflare 对 same-account target 做权威检查；target 缺失时部署必须失败。

## 2. 本地 preflight（无上传）

从 clean candidate commit 执行：

```bash
npm ci
npm run deploy:production -- --dry-run
```

该命令只允许 `--dry-run` 这个可选参数。它会检查 production config、fixture/non-live runtime metadata、download production gate，并运行完整 tests 与 default/staging/production Wrangler dry-run。成功结尾必须包含：

```text
DRY RUN ONLY: validation completed; no Cloudflare upload or deployment occurred.
```

这不是 actual deployment evidence。

## 3. 记录 rollback target

在部署前，以同一 credential/account 读取 production deployment history，并把当前 active version ID 记录到 repository 之外的受控变更记录：

```bash
npx wrangler deployments list --env production --json
```

若这是首次 deployment，不会有可回退的旧 version；operator 必须先接受只能 fix-forward 的风险。不要猜测 version ID。

## 4. Production deploy

用 secret manager 注入环境变量，或在不会保存输入的当前 Bash session 中读取：

```bash
read -r -p "Cloudflare account ID: " CLOUDFLARE_ACCOUNT_ID
read -r -s -p "Cloudflare API token: " CLOUDFLARE_API_TOKEN
printf '\n'
export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
npm run deploy:production
```

Entrypoint 会再次要求 clean Git worktree，重新运行完整 validation，然后固定调用本地锁定的 Wrangler：

```text
wrangler deploy --config <repo>/wrangler.toml --env production --strict
```

`--strict` 会拒绝冲突的 remote changes；`--env production` 与 config path 由 script 内部固定，调用者不能省略或改成 default/staging。成功输出是 actual deployment evidence，应记录 commit、Wrangler 输出的 version/deployment ID、URL 与时间，但不得记录 token。

该 deploy 只上传本 repo 的 caller Worker code/assets/config：它不会修改 sibling checkout bytes，不会部署 `cloudflare-download-site`，也不会直接读取、写入或删除 downstream R2 objects。

## 5. Production verification

把 deploy 输出的实际 HTTPS URL 写入当前 shell；不要猜测 account subdomain：

```bash
read -r -p "Production URL from Wrangler output: " PRODUCTION_BASE_URL
PRODUCTION_BASE_URL="${PRODUCTION_BASE_URL%/}"
export PRODUCTION_BASE_URL
```

先验证 fixture/non-live 与 binding state：

```bash
curl --fail-with-body --silent --show-error "$PRODUCTION_BASE_URL/api/health" \
  | jq -e '
      .phase == "2" and
      .content_adapter == "fixture" and
      .live_newapi == false and
      .pricing_context.user_group == "default" and
      .pricing_context.selected_group == "default" and
      .downloads.mode == "production-service-binding" and
      .downloads.configured == true and
      .downloads.bound == true and
      .downloads.active == true and
      .downloads.healthy == null and
      .downloads.live == false and
      .downloads.phase == "bound-unverified"
    '

curl --fail-with-body --silent --show-error "$PRODUCTION_BASE_URL/api/content/docs" \
  | jq -e '.data.meta.source == "fixture" and .data.meta.fixture == true and .data.meta.live == false'

curl --fail-with-body --silent --show-error "$PRODUCTION_BASE_URL/api/content/pricing" \
  | jq -e '
      .meta.source == "fixture" and
      .meta.fixture == true and
      .meta.live == false and
      .context == {user_group:"default", selected_group:"default", locked:true}
    '
```

再以安全 GET 验证 actual downstream forwarding：

```bash
curl --fail-with-body --silent --show-error --output /dev/null \
  "$PRODUCTION_BASE_URL/downloads"
curl --fail-with-body --silent --show-error --output /dev/null \
  "$PRODUCTION_BASE_URL/api/public"
```

以上 GET 可证明该时刻的实际 caller/binding/downstream 路径可达，但不会把 download status 改称 `healthy=true` 或 `live=true`，也不能证明所有 binary/R2 objects 或 admin mutation flow。不要用 HEAD 验证 downstream：审查的 target source 没有显式 HEAD handler。

严禁把 verification 扩展为匿名或自动化 admin POST。Gateway 会原样转发 cookie、body 与 method；任何 `/admin/login`、upload、publish、rollback 等 POST 都可能实际修改 downstream production/R2 state，必须由有权 operator 依据 downstream runbook 单独控制。

## 6. Rollback

若 verification 失败且部署前记录了已知良好的 previous version ID，执行：

```bash
npx wrangler rollback <PREVIOUS_VERSION_ID> --env production \
  --message "rollback failed production verification"
```

Rollback 会立即建立新的 caller deployment；随后重跑第 5 节 verification。Cloudflare 的 [Workers rollback 文档](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) 说明 rollback 不修改 connected resources，但旧 version 依赖的 binding/resource 必须仍存在。

Caller rollback 不会恢复任何此前经 `/admin/*` POST 写入的 downstream/R2 state；这类恢复只能按 `cloudflare-download-site` 自己的生产 runbook 处理，不能由本 repo 代替。

最后撤销短时 token 并清理当前 shell：

```bash
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID PRODUCTION_BASE_URL
```

## 本 follow-up 的证据边界

本地完成只代表 repository 已具备 production config、guarded deploy entrypoint、tests、三个 dry-run lane 与操作 runbook。本 follow-up 本身没有 login、remote call、production deploy、rollback、R2 mutation 或 push；不得把以上命令文本或 dry-run output 宣称为已部署结果。
