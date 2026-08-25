# Production deployment runbook

本 runbook 部署命名环境 `production`，Cloudflare Worker 名称预计为 `cloudflare-newapi-page-production`。Repository 的唯一实际部署入口是 `npm run deploy:production`；不要直接执行 `wrangler deploy`，也不要用 `CLOUDFLARE_ENV`、额外 CLI 参数或另一份 config 绕过入口。

## 1. 权限与资源前置条件

使用短时、限定单一目标 account（可再限制 TTL/IP）的 custom API token。此 Worker 只使用 Workers Static Assets、明文 config vars、Worker Service Binding 与一个既有 VPC Service binding；在显式提供 `CLOUDFLARE_ACCOUNT_ID`、account 已有 workers.dev subdomain、且不管理 zone route 的前提下，最小权限/角色是：

- Account / Workers Scripts / Edit。
- Account role / `Connectivity Directory Bind`，只用于读取、列出并绑定既有 VPC Service。

Cloudflare 的 Worker upload API 把 `Workers Scripts Write` 列为所需权限；Dashboard custom token 中对应 `Workers Scripts / Edit`。Cloudflare Workers VPC 文档明确要求 `Connectivity Directory Bind` 才能把 Worker 绑定到既有 VPC Service；`Connectivity Directory Admin` 仅用于创建、更新、删除 VPC Service 或直接绑定 Tunnel，本部署不需要也不得申请。配置不会创建或管理 VPC/Tunnel、DNS、Secrets Store、zone route、KV、D1 或 R2 resource，因此不要授予 Connectivity Directory Admin、Account Settings Edit、Workers Routes Edit、Workers KV/R2 Storage Edit、DNS Edit、Tunnel/VPC Admin 或 account-wide unrestricted 权限。若当前 Wrangler/组织策略返回明确的缺权错误，停止并由 account owner 审核；不要自行扩大 token scope。参考 [Worker upload API permission](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/update/) 与 [VPC Service required roles](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/#required-roles)。

Production entrypoint 要求 `CLOUDFLARE_ACCOUNT_ID` 与 `CLOUDFLARE_API_TOKEN` 只存在于当前 process environment。不要写入 repository、`.env*`、`.dev.vars*`、shell history、构建日志或 commit。官方 credential 与 CI 说明：

- [Wrangler system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)
- [External CI/CD authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/gitlab-cicd/)

本 repo 锁定的 Wrangler 4.124.0 在 `--env production` 下会自动依序加载 `.env`、`.env.local`、`.env.production` 与 `.env.production.local`。这些文件都被 Git 忽略，clean worktree 不能证明它们不存在；production entrypoint 会逐一拒绝，并继续拒绝 `.dev.vars` 与 `.dev.vars.production`。测试只在 OS temporary directory 建立 synthetic non-credential files，不会把 credential 或 dotenv 写进 repository。

Entrypoint 也会 fail closed 拒绝下列会改变 pinned Wrangler 行为的 process environment；若 operator 的普通 shell 预设了这些变量，必须先在受控环境中清除，不能靠它们改向或旁路 production：

- control plane/environment：`CLOUDFLARE_API_BASE_URL`、`CF_API_BASE_URL`、`CLOUDFLARE_BASE_URL`、`WRANGLER_API_ENVIRONMENT`、`CLOUDFLARE_COMPLIANCE_REGION`、`CLOUDFLARE_ENV`；
- proxy：`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 及其小写形式；
- log/output：`WRANGLER_LOG`、`WRANGLER_LOG_PATH`、`WRANGLER_LOG_SANITIZE`、`WRANGLER_WRITE_LOGS`、`WRANGLER_OUTPUT_FILE_DIRECTORY`、`WRANGLER_OUTPUT_FILE_PATH`；
- deprecated/global credential aliases：`CF_API_TOKEN`、`CF_ACCOUNT_ID`、`CLOUDFLARE_API_KEY`、`CF_API_KEY`、`CLOUDFLARE_EMAIL`、`CF_EMAIL`。

资源还必须满足：

1. `CLOUDFLARE_ACCOUNT_ID` 指向准备部署 caller Worker 的 account，且该 account 已有可用的 `workers.dev` subdomain。
2. 名为 `cloudflare-download-site` 的 target Worker 已先部署在同一 account。Cloudflare Service Binding 只能绑定本 account 的 Worker，且 target 必须先于 caller 存在；本 repo 不创建或部署 target。见 [Service Bindings deployment](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#deployment)。
3. Production live content prerequisites are already controller-verified: Worker secret `LIVE_CONTENT_ADAPTER_TOKEN`, VPC binding `NEWAPI_VPC_SERVICE`, its reviewed service ID/private route, and the NewAPI runtime secret are present and healthy. Do not copy or record their values here.
4. Account owner 已确认 deployed target 的生产语义与本 repo 审查的 transport contract 相容。Local sibling commit/hash 不是 deployed-source 证明。
5. Operator 已明确 production URL 的访问控制。`DOWNLOADS` R2 binding
   supplies migrated Downloads authority; the retained Service Binding is
   rollback-only and does not provide browser-side admin authorization.

Local preflight 与 `wrangler deploy --dry-run` 不会查询已部署 target 是否存在，也不会证明 binding、R2 objects 或 production route 可用。实际 deployment request 才会由 Cloudflare 对 same-account target 做权威检查；target 缺失时部署必须失败。

## 2. 本地 preflight（无上传）

从 clean candidate commit 执行：

```bash
npm ci
npm run deploy:production -- --dry-run
```

该命令只允许 `--dry-run` 这个可选参数。它会在 validation 前取得 clean full commit，检查 production config、已授权的 `CONTENT_ADAPTER=newapi` live runtime contract（包括 health response/schema validation）、download production gate，以及已核对的 `NEWAPI_VPC_SERVICE` binding，并运行完整 tests 与 default/staging/production Wrangler dry-run。Validation 后会再次要求同一 HEAD 与 clean tracked/untracked worktree；成功结尾必须包含同一个 40 位 commit：

```text
[production validation] PASS: clean commit <40_HEX_COMMIT>; HEAD and tracked/untracked worktree are unchanged.
[production preflight] DRY RUN ONLY: clean commit <40_HEX_COMMIT> validated; no Cloudflare upload or deployment occurred.
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

Entrypoint 会在 validation 前锁定 clean full commit，validation 后重验同一 HEAD 与 clean tracked/untracked worktree；在真正建立 Wrangler child process 前，还会再次检查同一 commit、所有 ignored dotenv 路径与上述 process environment。任一 dirty file、untracked file、HEAD drift 或隐藏输入出现都会停止。全部通过后才固定调用本地锁定的 Wrangler：

```text
wrangler deploy --config <repo>/wrangler.toml --env production --strict
```

`--strict` 会拒绝冲突的 remote changes；`--env production` 与 config path 由 script 内部固定，调用者不能省略或改成 default/staging。成功输出是 actual deployment evidence，应记录 commit、Wrangler 输出的 version/deployment ID、URL 与时间，但不得记录 token。

该 deploy 只上传本 repo 的 caller Worker code/assets/config：它不会修改 sibling checkout bytes，不会部署 `cloudflare-download-site`，也不会在 preflight 中直接读取、写入或删除 production R2 objects。Production config must include the reviewed `DOWNLOADS -> tokenrouter` R2 binding.

## 5. Current production cutover verification (live target only)

把 deploy 输出的实际 HTTPS URL 写入当前 shell；不要猜测 account subdomain：

```bash
read -r -p "Production URL from Wrangler output: " PRODUCTION_BASE_URL
PRODUCTION_BASE_URL="${PRODUCTION_BASE_URL%/}"
export PRODUCTION_BASE_URL
```

先验证 NewAPI live contract 与 binding state：

```bash
curl --fail-with-body --silent --show-error "$PRODUCTION_BASE_URL/api/health" \
  | jq -e '
      .phase == "2" and
      .content_adapter == "newapi" and
      .live_newapi == true and
      .live_newapi_healthy == true and
      .downloads.mode == "production-service-binding" and
      .downloads.configured == true and
      .downloads.bound == true and
      .downloads.active == true and
      .downloads.healthy == null and
      .downloads.live == false and
      .downloads.phase == "bound-unverified"
    '

curl --fail-with-body --silent --show-error "$PRODUCTION_BASE_URL/api/content/docs" \
  | jq -e '
      .data.meta.source == "newapi" and
      .data.meta.fixture == false and
      .data.meta.live == true and
      .data.meta.schema_version == 1 and
      .data.meta.renderer_version == 1
    '

# Validate a real Docs page, not only catalog metadata.
# The currently observed live catalog includes
# `page-1785606868894-3673ea8d4916890d`; derive the slug from the catalog so
# generated identifiers remain authoritative if NewAPI republishes the page.
LIVE_DOCS_SLUG="$(
  curl --fail-with-body --silent --show-error "$PRODUCTION_BASE_URL/api/content/docs" \
    | jq -er '
        .data.sections
        | map(.items)
        | add
        | map(.slug)
        | .[0] // empty
      '
)"
test -n "$LIVE_DOCS_SLUG"
curl --fail-with-body --silent --show-error \
  "$PRODUCTION_BASE_URL/api/content/docs/$LIVE_DOCS_SLUG" \
  | jq -e --arg slug "$LIVE_DOCS_SLUG" '
      .data.meta.source == "newapi" and
      .data.meta.fixture == false and
      .data.meta.live == true and
      .data.meta.schema_version == 1 and
      .data.meta.renderer_version == 1 and
      .data.page.slug == $slug and
      (.data.page.title | type == "string" and length > 0) and
      (.data.page.section | type == "string" and length > 0) and
      (.data.page.updated_at | type == "number" and . >= 0) and
      (.data.page.blocks | length > 0)
    '

curl --fail-with-body --silent --show-error "$PRODUCTION_BASE_URL/api/pricing" \
  | jq -e '
      .meta.source == "newapi" and
      .meta.fixture == false and
      .meta.live == true and
      (.success == true) and
      (.group_ratio | type == "object")
    '
```

再运行 repository-owned 的 production read-only downloads probe。它只接受 HTTPS production URL，输出每个请求的无 body summary；先检查 exact GET `/downloads` 是 NewAPI R2-backed landing HTML（`JuAPI 软件下载中心`、两个 configured software groups 与 `download-group-grid`），再检查 `/downloads/software/:softwareId` 是 R2-backed software page，然后从 `/api/downloads/catalog` 发现并校验每个 software ID，逐一读取 `/downloads/api/:softwareId/public`，对明确 404 的 ID 再读取对应 `latest` metadata，最后验证一个代表性的 mounted `/downloads/download/...` 与 direct `/download/...` 路由。代表性 download response 只读 headers 后立即取消 body，不下载大 artifact，也不 follow redirect。旧版 `main#main-content` 与 `/static/app.js` detail-SPA markers 在 R2 migration 后不再是必要条件：

```bash
PROBE_EVIDENCE_DIR="$(mktemp -d)"
set -o pipefail
if PRODUCTION_BASE_URL="$PRODUCTION_BASE_URL" npm run probe:production:downloads \
  | tee "$PROBE_EVIDENCE_DIR/production-download-probe.jsonl"; then
  PROBE_EXIT=0
else
  PROBE_EXIT=$?
fi
set +o pipefail
printf 'probe_exit_code=%s evidence=%s\n' "$PROBE_EXIT" \
  "$PROBE_EVIDENCE_DIR/production-download-probe.jsonl"
test "$PROBE_EXIT" -eq 0
```

只有实际运行的 stdout JSONL、exit code、candidate commit、production URL、account、开始/结束时间都保存到 repository 外部，且最后一行为 `{"success":true,...}` 时，才可记录该时刻的 live downloads chain PASS。命令文本、local mock、dry-run 或缺少 output 都不是 live success。Probe 使用 `credentials: omit`、`redirect: manual`，只允许 GET/HEAD；不要把发现的 ID 或下载 target 改回固定 `codex-installer`。

以上 checks 可证明该时刻的实际 caller/R2 binding/route 路径可达，但不会把 download status 改称 `healthy=true` 或 `live=true`，也不能证明所有 binary/R2 objects 或 admin mutation flow。不要用 HEAD 验证下载成功：源 Worker没有显式 HEAD handler；`HEAD /downloads` 的 404 只能作为 method-preservation evidence。

严禁把 verification 扩展为匿名或自动化 admin POST。任何 `/admin/login`、upload、publish、rollback 等 POST 都可能实际修改 production R2 state，必须由有权 operator 单独控制。

## 6. Rollback

若 verification 失败且部署前记录了已知良好的 previous version ID，先确认 rollback target 的 source commit；不接受无法精确绑定到已审查 target 的 rollback。

```bash
read -r -p "Rollback version ID: " ROLLBACK_VERSION_ID
test -n "$ROLLBACK_VERSION_ID"
read -r -p "Rollback target source commit: " ROLLBACK_TARGET_SOURCE_COMMIT
ROLLBACK_FIXTURE_PARENT_COMMIT="a0bce69108d7898c75385dd64b16e4deb927a3e0"
case "$ROLLBACK_TARGET_SOURCE_COMMIT" in
  "$ROLLBACK_FIXTURE_PARENT_COMMIT") ;;
  *)
    printf 'Unsupported rollback target source commit; refusing verification.\n' >&2
    exit 1
    ;;
esac

npx wrangler rollback "$ROLLBACK_VERSION_ID" --env production \
  --message "rollback failed production verification"
```

The exact `a0bce69108d7898c75385dd64b16e4deb927a3e0` parent is fixture-backed; after that rollback, use fixture predicates and do not judge it by live=true:

```bash
curl --fail-with-body --silent --show-error "$PRODUCTION_BASE_URL/api/health" \
  | jq -e '
      .phase == "2" and
      .content_adapter == "fixture" and
      .live_newapi == false and
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
curl --fail-with-body --silent --show-error "$PRODUCTION_BASE_URL/api/content/docs/quickstart" \
  | jq -e '
      .data.meta.source == "fixture" and
      .data.meta.fixture == true and
      .data.meta.live == false and
      .data.page.slug == "quickstart" and
      (.data.page.title | type == "string" and length > 0) and
      (.data.page.section | type == "string" and length > 0) and
      .data.page.updated_at == null and
      (.data.page.blocks | length > 0)
    '
curl --fail-with-body --silent --show-error "$PRODUCTION_BASE_URL/api/pricing" \
  | jq -e '
      .meta.source == "fixture" and
      .meta.fixture == true and
      .meta.live == false and
      .success == true
    '
```

Cloudflare 的 [Workers rollback 文档](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) 说明 rollback 不修改 connected resources，但旧 version 依赖的 binding/resource 必须仍存在。

Caller rollback 不会恢复任何此前经 `/admin/*` POST 写入的 R2 state；这类恢复只能按 Downloads owner 的生产 runbook 处理，不能由本 repo 代替。

最后撤销短时 token 并清理当前 shell：

```bash
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID PRODUCTION_BASE_URL
```

## 本 follow-up 的证据边界

本地完成只代表 repository 已具备 production config、guarded deploy entrypoint、tests、三个 dry-run lane 与操作 runbook。本 follow-up 本身没有 login、remote call、production deploy、rollback、R2 mutation 或 push；不得把以上命令文本或 dry-run output 宣称为已部署结果。
