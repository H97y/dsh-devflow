# dsh-devflow

DeepSeek Harness 的自动开发流水线插件：需求池 → LLM 批量精炼（含规模评估）→ 择优 →
设计 → 计划 → 评审&修订循环（≤3 轮）→ 实施（小需求主工作区 / 中大需求 worktree）→
代码评审循环（≤3 轮）→ Web 验证 → 集成分支合并回 main → 开发报告。
所有可能阻塞的决策默认由模型按项目规范自动决策；确需人工拍板的进入各阶段等待队列，
页面作答后自动续跑。全部状态持久化在 `<root>/.devflow/`。

浏览器端为原生嵌入式界面（非浮层弹窗）：侧边栏底部入口（与"设置"同层级）点击后
在主区域打开整页工作台。插件自行挂载生成的 Remote 命名空间，不修改 harness
产品源码，`pnpm add` 即装即用。

## 仓库布局

```
├── package.json / pnpm-workspace.yaml / tsconfig.{host,client}.json   # 仓库壳与聚合编译图
├── packages/devflow/          # 可发布包 dsh-devflow
│   ├── src/index.ts           # 宿主服务：状态机 + LLM 阶段 + devflow 模型工具
│   ├── src/prompts.ts         # 9 阶段默认提示词 + {{变量}} 渲染
│   ├── src/types.ts           # 公共类型
│   ├── src/client/            # 浏览器界面（侧边栏入口 + 主区域页面）
│   └── lib/typert.*           # vendored wire 工件（见下）
└── scripts/
    ├── tsdown.client.ts       # vendored 自 harness 的浏览器 bundle 预设
    ├── platform.ts            # vendored 平台模块表
    ├── vendor-typert.sh       # 从 harness 拷贝并改名 typert 四件套（手动）
    └── sync-to-profile.sh     # 开发回路：link 进 dsh profile + 重建本仓库
```

## 开发回路（只读使用本地 harness checkout）

迭代期依赖用 `link:` 指向本地 `deepseek-harness` checkout（其 npm 版本目前落后于
checkout），路径硬编码在 `packages/devflow/package.json`，可按需调整。**harness
checkout 保持零改动**：插件以 link 安装进 `~/.dsh/profiles/web`，组合行
`dsh-devflow` 经 profile 的 node_modules 解析到本仓库；web 服务器的 `/plugins`
路由直接从本仓库 `lib/client.js` 读文件（no-cache）。

```bash
pnpm install && pnpm build && pnpm test   # 本仓库独立可构建
pnpm sync:profile                         # link 进 profile（首次/组合变化后需重启 dsh web）
```

日常迭代：改代码 → `pnpm build` → 浏览器刷新即可（无需重启，无需碰 harness）。

**Typert wire 工件为什么是 vendored**：生成器的 workspace 发现依赖 harness monorepo
布局（聚合 tsconfig 引用 + `<root>/packages/` 目录包含检查），无法在单包仓库内驱动。
`@Remote` 方法面变化时：临时把 `packages/devflow` 拷进某个 harness checkout 的
`packages/` 下重建，`scripts/vendor-typert.sh` 会把重新生成的 `lib/typert.*` 改名
（`@deepseek-ai/dsh-devflow` → `dsh-devflow`）后提交回本仓库；等 npm 版本追平
checkout 后可改为直接依赖 npm 包。

## 快速上手（安装与首次使用）

> **发布状态**：`dsh-devflow` 尚未发布到 npm（发布前置条件见「发布路径」节）。
> 在发布之前，外部用户请走下方「方式 B：从源码安装」。

### 前置条件

- 已安装 DeepSeek Harness CLI（`npm i -g @deepseek-ai/dsh`，rc 系列即可）并能运行
  `dsh web`；插件使用的 `sidebar.footer.action` 插槽需要较新的 rc 版本
- profile 使用的插件安装器是 pnpm（随 dsh 初始化）

### 方式 A：npm 安装（发布后可用，推荐）

一条命令完成依赖安装与组合接线（`dsh.bundle` manifest + 包内 `cordis.patch.yml`
自动生效，`@deepseek-ai/*` peer 依赖由 pnpm 自动解析，无需手动处理）：

```bash
dsh plugin --profile web add dsh-devflow
```

### 方式 B：从源码安装（当前可用；需要本地 deepseek-harness checkout）

运行时依赖与构建期类型当前以 `link:` 指向本地 harness checkout（见「开发回路」
节），因此克隆本仓库后需把 `packages/devflow/package.json` 中的 link 路径改为
你的 checkout 路径，再构建并 link 进 profile：

```bash
git clone https://github.com/H97y/dsh-devflow.git
cd dsh-devflow
# 编辑 packages/devflow/package.json：把 link:/Users/heyue/deepseek-harness/...
#   改为 link:<你的-harness-checkout>/...（构建期类型解析也需要它）
pnpm install && pnpm build && pnpm test
pnpm sync:profile        # link 进 ~/.dsh/profiles/web（DSH_PROFILE 可换 profile）
```

> 无本地 harness checkout 的用户请等待 npm 发布（方式 A）。

### 配置工作区

`root` 默认取进程工作目录；如需指向特定工作区，在你的 profile patch 层
（`~/.dsh/profiles/web/cordis.patch.yml`）覆盖：

```yaml
- id: devflow
  config:
    root: /path/to/your/workspace   # .devflow/ 状态与小需求工作区所在
    # maxActive: 3                  # 并发流水线上限（默认 3）
    # maxWorktrees: 2               # worktree 并发上限（默认 2）
    # logCap: 40                    # 每条需求日志上限（默认 40）
    # tickIntervalMs: 2000          # 状态机节拍（默认 2000）
```

### 验证与首次使用

1. （首次安装或组合变化后）重启 `dsh web`，浏览器打开 Web 界面
2. **验证挂载**：侧边栏底部、「设置」按钮上方出现「开发流水线」入口（侧边栏
   折叠时是 56px 轨道圆钮）——没有即未挂载，见下方排查
3. 点击入口打开主区域工作台；在「需求池入口」粘贴一句粗浅需求（如
   「给列表加个搜索框」）→「投入需求池」
4. 后台自动开始：批量精炼（含规模评估）→ 择优 → 设计 → 计划 → 评审修订 →
   实施（`devflow` 模型工具由会话泵调用）→ 代码评审 → Web 验证 → 合并回 main → 报告；
   需要你拍板的会停在「等待队列」，页面上作答后自动续跑
5. 全部状态在 `<root>/.devflow/`，进程重启不丢

### 故障排查

| 现象 | 处理 |
|---|---|
| 侧边栏没有「开发流水线」入口 | 重启 `dsh web`；仍无则 `curl -s http://127.0.0.1:3080/ \| grep -o 'dsh-devflow[^"]*'` 看启动名单里是否有本包，没有则检查 profile 是否装上（`~/.dsh/profiles/web/node_modules/dsh-devflow`）与 `cordis.patch.yml` 插入行 |
| 页面打开但状态栏报连接错误 | 宿主半边未挂载：确认组合行 `name: dsh-devflow` 与安装的包名一致 |
| 找不到 `.devflow/` 目录 | 它在 `root` 配置下（默认 `dsh web` 的启动目录）；按「配置工作区」显式指定 |

浏览器界面分两处挂载：入口按钮注册在 `sidebar.footer.action`（侧边栏底部、
与"设置"同层级，样式对齐原生触发行，折叠时为 56px 轨道圆钮，带待决策计数徽标）；
点击后在 `shell.overlay` 打开主区域整页（锚定侧边栏右缘、随拖拽/折叠自适应，
左列需求池 + 右侧详情/产物/提示词编辑的双栏布局，Esc 逐级返回）。浏览器半边
自行 `$mount` 本包生成的 `/remote` 产物——`remote.devflow` 命名空间由插件自己
挂载，不依赖宿主装配接线，npm 安装路径即装即用。模型工具 `devflow`
（`next` / `report`）由会话泵调用以执行 implement / fix-code / verify / merge
任务。

## 发布路径

1. `peerDependencies` 已按 npm 版本范围声明；`link:` 依赖仅存在于
   `devDependencies`/`dependencies` 的迭代副本，发布前需切回 npm 范围并验证
   （当前 npm 上的 `@deepseek-ai/dsh-*` rc 版本落后于 harness checkout，等追平后切换）。
2. `pnpm --filter dsh-devflow publish --access public`
3. GitHub 仓库添加 topic `dsh-plugin`（官方生态的发现机制）。
