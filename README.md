# dsh-devflow

DeepSeek Harness 的自动开发流水线插件：需求池 → LLM 批量精炼（含规模评估）→ 择优 →
设计 → 计划 → 评审&修订循环（≤3 轮）→ 实施（小需求主工作区 / 中大需求 worktree）→
代码评审循环（≤3 轮）→ Web 验证 → 集成分支合并回 main → 开发报告。
所有可能阻塞的决策默认由模型按项目规范自动决策；确需人工拍板的进入各阶段等待队列，
页面作答后自动续跑。全部状态持久化在 `<root>/.devflow/`。
需求池按项目隔离且零配置：工作区内的项目自动发现，面板内可添加/移除任意项目目录，
多项目流水线并行推进。

浏览器端为原生嵌入式界面（非浮层弹窗）：侧边栏底部入口（与"设置"同层级）点击后
在主区域打开整页工作台。插件自行挂载生成的 Remote 命名空间，不修改 harness
产品源码，`pnpm add` 即装即用。

## 仓库布局

```
├── package.json / pnpm-workspace.yaml / tsconfig.{host,client}.json   # 仓库壳与聚合编译图
├── packages/devflow/          # 可发布包 dsh-devflow
│   ├── src/index.ts           # 宿主服务：按项目隔离的状态机 + LLM 阶段 + devflow 模型工具
│   ├── src/projects.ts        # 项目标记识别 + 分区身份（key 派生/去重）
│   ├── src/prompts.ts         # 9 阶段默认提示词 + {{变量}} 渲染
│   ├── src/types.ts           # 公共类型
│   ├── src/client/            # 浏览器界面（侧边栏入口 + 带项目切换器的主区域页面）
│   └── lib/typert.*           # vendored wire 工件（见下）
└── scripts/
    ├── tsdown.client.ts       # vendored 自 harness 的浏览器 bundle 预设
    ├── platform.ts            # vendored 平台模块表
    ├── vendor-typert.sh       # 旧流程：从 harness 拷贝并改名 typert 四件套（手动，备用）
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

**Typert wire 工件为什么是 vendored、如何再生成**：生成器的工作区发现要求被分析包与
`@deepseek-ai/dsh-typert-protocol` 以真实目录形式位于同一 `<root>/packages/` 下（其对
`@Remote` 装饰器的识别要把符号声明解析到已注册的 protocol 包）。`@Remote` 方法面变化时，
运行 `pnpm --filter dsh-devflow run gen:typert`：脚本会在本仓库内组装一次性临时工作区
（`.typert-gen/`，已 git-ignore），放入本包与 protocol 包的真实副本及把 protocol 导入钉到
本地副本的临时聚合配置，直接重新生成四件套到 `wire/` 后清理现场——全程不触碰 harness
checkout。（`scripts/vendor-typert.sh` 旧的拷进 harness 流程保留为备用。）等 npm 版本追平
checkout 后可改为直接依赖 npm 包。

## 快速上手（安装与首次使用）

> **发布状态**：`dsh-devflow@0.1.0` 已发布 npm（[registry](https://www.npmjs.com/package/dsh-devflow)），
> 一条命令即可安装；从源码安装仅开发者需要。

### 前置条件

- 已安装 DeepSeek Harness CLI（`npm i -g @deepseek-ai/dsh`，rc 系列即可）并能运行
  `dsh web`；插件使用的 `sidebar.footer.action` 插槽需要较新的 rc 版本
- profile 使用的插件安装器是 pnpm（随 dsh 初始化）

### 安装（npm，推荐）

一条命令完成依赖安装与组合接线（`dsh.bundle` manifest + 包内 `cordis.patch.yml`
自动生效，`@deepseek-ai/*` peer 依赖由部署预装，无需手动处理）：

```bash
dsh plugin --profile web add dsh-devflow
```

### 从源码安装（仅开发者；需要本地 deepseek-harness checkout）

运行时依赖已全部走 npm；仅构建期类型仍以 `link:` 指向本地 harness checkout
（见「开发回路」节）。克隆本仓库后需把 `packages/devflow/package.json` 中的
link 路径改为你的 checkout 路径，再构建并 link 进 profile：

```bash
git clone https://github.com/H97y/dsh-devflow.git
cd dsh-devflow
# 编辑 packages/devflow/package.json：把 link:/Users/heyue/deepseek-harness/...
#   改为 link:<你的-harness-checkout>/...（构建期类型解析需要它）
pnpm install && pnpm build && pnpm test
pnpm sync:profile        # link 进 ~/.dsh/profiles/web（DSH_PROFILE 可换 profile）
```

### 配置工作区

`root` 默认取进程工作目录，指向你的项目集合目录即可（无需其他配置）；如需覆盖，
在你的 profile patch 层（`~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- id: devflow
  config:
    root: /path/to/your/projects   # 项目发现从这里扫描；默认项目的 .devflow/ 也在其下
    # maxActive: 3                  # 单项目并发流水线上限（默认 3）
    # maxWorktrees: 2               # 单项目 worktree 并发上限（默认 2）
    # logCap: 40                    # 每条需求日志上限（默认 40）
    # tickIntervalMs: 2000          # 状态机节拍（默认 2000）
```

**项目自动发现与管理（零配置）**：插件自动扫描 `root` 下的独立项目目录（含 `.git` /
`package.json` / `go.mod` 等标记的文件夹；`root` 自身是单仓库时视为一个项目，是项目
集合目录时扫到二级如 `~/projects/group/repo`），右上角下拉框即可切换——每个项目拥有
完全隔离的需求池、`.devflow/` 状态、提示词、状态机节拍与主工作区/worktree 配额，
多项目流水线并行推进互不争用。工作区外的项目可在下拉框旁的「＋」里添加：系统目录
选择器 / 应用内目录浏览 / 直接粘贴路径（与 GUI 添加工作区同源同体验），也可随时移除
或恢复；手动添加与隐藏记录持久化在 `<root>/.devflow/projects.json`。需求 id 内嵌项目
key（`<key>-r<n>`），面板操作与会话泵回填都据此自动路由。

### 阶段模型配置

工作台头部「设置」打开统一设置面板：每个流水线阶段（精炼/设计/计划/评审/代码评审/报告）
可单独指定模型，候选列表只读自 harness 已配置模型（插件不管理任何 API key）。未配置的
阶段回退 harness 当前模型；已配置模型被 harness 移除时运行时回退并在面板标记「已漂移」。
修改保存后即时生效，持久化在 `<root>/.devflow/settings.json`（运行时状态，git 不跟踪）。

重置语义：删除 settings.json 即重置为默认配置（下次加载会自动重建默认文件）。

面板边界：提示词模板仍在工作台「提示词」入口按项目编辑（内容型配置，不迁入设置面板）；
`root` / 并发上限等宿主级配置由 profile patch 层管理，不属插件面板。

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

`dsh-devflow@0.1.0` 已于 2026-08-17 发布 npm。后续版本的发布流程：

1. 运行时依赖全部为 npm 范围；`devDependencies` 中的 `link:` 仅构建期使用，不随包
   发布。npm 上的 `@deepseek-ai/dsh-*` rc 版本落后于 harness checkout 时，以
   `peerDependencies` 的 `>=` 范围兼容（已按此声明）。
2. 改 `packages/devflow/package.json` 的 `version` → `pnpm build && pnpm test` →
   `pnpm --filter dsh-devflow publish --access public`
3. GitHub 仓库已添加 topic `dsh-plugin`（官方生态的发现机制）。
