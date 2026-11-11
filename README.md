# 卡丘HUB 官方 DSH 插件

在 DeepSeek Harness 中查询卡拉彼丘玩家资料与公开战绩。插件连接 [卡丘HUB](https://kqhub.win) 的 MCP 服务，首次使用时打开浏览器，由你登录并确认授权。

可以直接问 DSH：

> 查询玩家 3586568 的本赛季表现。
>
> 看看我绑定的账号最近几场打得怎么样。
>
> 分析这场对局的比分和个人数据。

## 安装

需要 Node.js 24.9 及以上版本、DeepSeek Harness **0.2.2-rc.1**，以及有 MCP 查询权限的卡丘HUB 账号。当前版本按这条 DSH 发行线验证，官方 MCP 客户端的 npm `latest` 标签仍指向旧版本，安装依赖时请保留本项目指定的版本。

安装发布包：

```sh
dsh plugin --profile web add dsh-plugin-kqhub
dsh plugin --profile web exec kqhub-auth
dsh web
```

离线分发时，开发者运行 `npm pack` 生成 `dsh-plugin-kqhub-0.1.0.tgz`，用户安装该文件：

```sh
dsh plugin --profile web add ./dsh-plugin-kqhub-0.1.0.tgz
dsh plugin --profile web exec kqhub-auth
dsh web
```

`package.json` 中的 `dsh.bundle` 会加载 `cordis.patch.yml`，安装后自动启用查询插件。发布包包含编译产物，安装 tarball 无需额外构建。

## 首次授权

运行 `npm run auth`（安装包用户运行 `dsh plugin --profile web exec kqhub-auth`），在浏览器中完成卡丘HUB 登录并确认权限，然后启动 DSH。先授权可以留出完整的登录时间，避免首次登录占用宿主的 MCP 握手等待时间。授权使用 OAuth 与 PKCE，不需要把网站密码或 Cookie 填进插件配置。浏览器和 DSH 应运行在同一台电脑，授权回调通过本机回环地址接收。

默认请求玩家资料、生涯、战绩、账号绑定和用量的读取权限，以及用于续期的 `offline_access`。实际可用工具取决于账号权限与批准的授权范围。你可以在卡丘HUB 的“应用授权”中撤销授权，在“MCP 用量”中查看额度。

授权凭据由 `mcp-remote` 保存在当前系统用户的 `~/.mcp-auth` 下，不进入插件目录。不要共享该目录或把它提交到 Git。多人使用时分别运行在各自的系统账号下。

## 查询范围

| 想查询的内容 | MCP 工具 |
| --- | --- |
| 搜索玩家、查看资料 | `search_players`、`get_player_profile` |
| 资料、生涯和近期战绩概览 | `get_player_overview` |
| 赛季生涯、近期战绩、单局详情 | `get_player_career`、`list_player_matches`、`get_match_detail` |
| 我的绑定账号 | `get_my_bindings` |
| 查询用量、赛季、游戏字典 | `get_mcp_usage`、`list_seasons`、`get_game_reference` |
| 续取或复用查询结果 | `get_query_result` |

工具在 DSH 中带有 `mcp__kqhub__` 前缀，参数与说明从服务端发现，无需手工维护一份接口副本。

综合分析优先使用 `get_player_overview`，一次查询即可取得资料、生涯和近期战绩，按一次数据查询计费。只问单项时使用对应工具。已知玩家 ID 就直接查询，近期表现先看战绩列表，需要复盘指定对局时再取详情。

服务端返回 `pending` 时，按 `retry_after` 等待，再用原 `query_handle` 调用 `get_query_result`。不要重新发起原查询。已完成的结果也能在原有效期内通过句柄复用，续取不增加每日数据查询计次。额度和有效期以服务端返回为准。

比分按返回的玩家视角解释，击败数与队伍回合比分分别展示。缺失数据保留缺失，不推测未返回的逐回合操作。

## 配置

默认配置即可连接官方服务。需要调整权限或超时时，在 profile 的 `cordis.patch.yml` 覆盖 `kqhub` 行，例如：

```yaml
- id: kqhub
  config:
    scopes:
      - players:read
      - career:read
      - matches:read
      - usage:read
      - offline_access
    authTimeoutSeconds: 180
    toolCallTimeoutMs: 60000
```

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `url` | `https://kqhub.win/mcp` | MCP 入口，开发时可改为本机 `/mcp` 地址 |
| `scopes` | 上述五类只读权限及 `offline_access` | 减少请求的权限范围 |
| `authTimeoutSeconds` | `180` | 等待浏览器授权，允许 30–600 秒 |
| `toolCallTimeoutMs` | `60000` | 单次工具调用超时，允许 1000–120000 毫秒 |

修改权限后需要重新授权。停用或卸载插件会关闭连接并移除工具，本地授权记录仍由 `mcp-remote` 管理。

## 开发

```sh
npm ci
npm run check
npm test
npm pack
```

```text
dsh-plugin-kqhub/
├── package.json          # npm 元数据、依赖与 dsh.bundle
├── cordis.patch.yml      # 安装时插入插件
├── src/index.ts          # 配置校验与官方 MCP 客户端装配
├── src/auth.ts           # 首次浏览器授权命令
├── lib/                  # 构建产物，随发布包交付
├── locale/               # DSH 插件名称和介绍
└── tests/                # 配置、协议和生命周期验证
```

插件使用 DSH 官方 `@deepseek-ai/dsh-mcp-client` 注册工具、传递取消并清理连接。`mcp-remote` 处理远程 HTTP 和浏览器授权。启动时直接运行已安装的代理文件，不调用 shell 或临时下载依赖。查询缓存、额度与查询句柄归服务端管理，插件不增加自动轮询、重复查询或后台预取。

工具说明和服务端指令由官方客户端传给模型。同一次连接复用工具目录，不为每个查询重新启动进程。依赖版本记录在 `package-lock.json` 中。

开发依据为 [DSH 第一个插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.zh.md)、[打包与安装插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)、[官方 MCP 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.zh.md)及 [mcp-remote](https://github.com/punkpeye/mcp-remote)。

维护者发布新版本前先运行上述检查，再使用 `npm publish --access public`。包内只包含运行所需文件，源码、测试和本地授权文件不随包分发。

## 许可证

[MIT](LICENSE)
