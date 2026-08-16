# dsh-devflow

DeepSeek Harness 的自动开发流水线插件：需求池 → LLM 批量精炼（含规模评估）→ 择优 →
设计 → 计划 → 评审&修订循环（≤3 轮）→ 实施（小需求主工作区 / 中大需求 worktree）→
代码评审循环（≤3 轮）→ Web 验证 → 集成分支合并回 main → 开发报告。
所有可能阻塞的决策默认由模型按项目规范自动决策；确需人工拍板的进入各阶段等待队列，
面板作答后自动续跑。全部状态持久化在 `<root>/.devflow/`。

## 仓库布局

```
├── package.json / pnpm-workspace.yaml / tsconfig.{host,client}.json   # 仓库壳与聚合编译图
├── packages/devflow/          # 可发布包 dsh-devflow
│   ├── src/index.ts           # 宿主服务：状态机 + LLM 阶段 + devflow 模型工具
│   ├── src/prompts.ts         # 9 阶段默认提示词 + {{变量}} 渲染
│   ├── src/types.ts           # 公共类型
│   ├── src/client/            # 浏览器面板（shell.overlay 挂载）
│   └── lib/typert.*           # vendored wire 工件（见下）
└── scripts/
    ├── tsdown.client.ts       # vendored 自 harness 的浏览器 bundle 预设
    ├── platform.ts            # vendored 平台模块表
    ├── vendor-typert.sh       # 从 harness 拷贝并改名 typert 四件套
    └── sync-to-harness.sh     # 开发回路：同步源码 → 重建 harness → 回收 typert
```

## 开发回路（依赖本地 harness checkout）

迭代期依赖用 `link:` 指向本地 `deepseek-harness` checkout（其 npm 版本目前落后于
checkout），路径硬编码在 `packages/devflow/package.json`，可按需调整。

```bash
pnpm install && pnpm build && pnpm test   # 本仓库独立可构建
pnpm sync:harness                         # 源码同步进 harness 并重建挂载产物
```

**Typert wire 工件为什么是 vendored**：生成器的 workspace 发现依赖 harness monorepo
布局（聚合 tsconfig 引用 + `<root>/packages/` 目录包含检查），无法在单包仓库内驱动。
`@Remote` 方法面变化后运行 `pnpm sync:harness`，它会重建 harness 并把重新生成的
`lib/typert.*` 改名（`@deepseek-ai/dsh-devflow` → `dsh-devflow`）后提交回本仓库。

## 安装（最终用户）

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-devflow
```

`cordis.patch.yml` 增加：

```yaml
- insert:
    - id: devflow
      name: dsh-devflow
      config:
        root: /path/to/your/workspace   # .devflow/ 状态与小需求工作区所在
        # maxActive: 3                  # 并发流水线上限（默认 3）
        # maxWorktrees: 2               # worktree 并发上限（默认 2）
        # logCap: 40                    # 每条需求日志上限（默认 40）
        # tickIntervalMs: 2000          # 状态机节拍（默认 2000）
```

浏览器面板挂在 `shell.overlay`（右下角）；模型工具 `devflow`（`next` / `report`）
由会话泵调用以执行 implement / fix-code / verify / merge 任务。

## 发布路径

1. `peerDependencies` 已按 npm 版本范围声明；`link:` 依赖仅存在于
   `devDependencies`/`dependencies` 的迭代副本，发布前需切回 npm 范围并验证
   （当前 npm 上的 `@deepseek-ai/dsh-*` rc 版本落后于 harness checkout，等追平后切换）。
2. `pnpm --filter dsh-devflow publish --access public`
3. GitHub 仓库添加 topic `dsh-plugin`（官方生态的发现机制）。
