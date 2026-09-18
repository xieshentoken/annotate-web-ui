# annotate-web-ui 改造方案：从「标注 → 复审」到「交互式 UI 编排」

> 状态：方案（未动代码）
> 范围：把现有 `annotate-web-ui` skill 改造成「打开 WebUI → 直接编排元素 → 生成 diff → 交给 agent 改前端」的工具
> 已确认的边界决定：**允许打开任意外部网站并注入探针**（原方案只允许 localhost / 仓库内静态）

---

## 0. 一句话结论

你列的能力里 **7/10 已经实现**，真正缺的只有 3 块，其中 2 块是「把已有能力搬家 + 加字段」，不是新建。

而且有一个决定性的实现事实让这件事比看上去简单得多：

> **页面 → 宿主的回传通道走的是 CDP binding（`Runtime.addBinding: __symbuiNative`），不是 HTTP 回调。**
> `scripts/start-session.mjs:597-601`

这意味着打开外部 HTTPS 站点**在传输层已经天然可用**——不受 CORS、不受混合内容拦截、不受页面 CSP 限制。放开外部网站**不需要重做通道**，只需要改策略校验（`assertReachableLocalUrl` / `isAllowedLocalUrl`）加一组隐私约束。

---

## 1. 现状盘点

### 1.1 已经具备

| 你要的能力 | 现状 | 实现位置 |
|---|---|---|
| 打开 webui 并交互 | ✅ | `scripts/start-session.mjs`，隔离 Chrome profile + 实时交互 |
| 识别 UI 元素 | ✅ | `assets/inventory-probe.js`：`selector` / `testId` / `id` / `role` / `name` / `tag` / `rect` / computed `style` / 反查 `tokens` / `reuseCount` |
| 自动获取组件名 | ✅（有注入器时最强） | `inventory.anchor = { file, line, column, component }`，来自 `plugins/` 编译期注入的 `data-ui-source` |
| 每个元素/组写修改提示词 | ✅ | `intent.{ operations, expected, scope, breakpoint, priority, invariants }`（`references/annotation-schema.md:132-140`） |
| 出 diff | ✅ | `scripts/revision-diff.mjs`，分类含 `added/removed/moved/resized/reordered/restyled`，并且已经区分 **primary / derived** |
| 框选 / 多选 | ✅ | 首轮工具栏（框选/点/箭头/遮挡）+ 复审画布批量选择 |
| 统一修改 prompt | ✅ | `references/prompt-contract.md` → `change-request.md` + `implementation-prompt.md` |
| 拖移 / 缩放 | ⚠️ 有，但在**复审阶段** | `assets/review.html:604-669`，inspect/move/resize 工具，输出 `manipulation.delta`（CSS px，`annotation-schema.md:145-163`） |
| 收敛回路 | ✅ | `references/review-loop.md`：捕获 → diff → 复审 → verdict → consolidate，最多 `review.maxRounds` 轮 |

### 1.2 缺口（本次要做的三块）

| 缺口 | 现状 | 影响 |
|---|---|---|
| **手动命名元素** | ❌ 无 `alias` 字段 | prompt 里只能引用 `A1` / `anchor.component`，人类可读的引用无处安放 |
| **自定义命名分组** | ❌ 无 `groups` 对象，只有一次性框选批量 | 无法表达「这几块属于同一个容器」，agent 读不懂 |
| **首轮直接操纵** | ⚠️ 拖拽/缩放只在复审画布 | 你必须先让 agent 改一版，才能拖；而你想的是「先摆好再让 agent 改」 |
| **外部站点探针** | ❌ 被策略拦住 | `assertReachableLocalUrl` (`start-session.mjs:117`) + `isAllowedLocalUrl` 门控 `printReady` (`start-session.mjs:610`) |
| **参考站点反推设计** | ❌ 无，且与「never upload a screenshot」边界冲突 | 无法把别的站点的设计意图带进来 |

### 1.3 一个容易被忽略的降级场景

没装构建注入器时（`plugins/vite-plugin-symbui.mjs` 等），anchor 只能靠 React/Vue 内部结构，**report 到组件级而不是元素级，且封顶 `medium` 置信度**（`README.md:48-50`）。

所以「手动命名」不只是方便——**它是这个降级场景下唯一可靠的人类可读引用**。P0 顺带把这个问题兜住了。

---

## 2. 目标工作流

```text
open <target>                    target = 仓库内静态 / localhost 开发服务 / 任意外部站点
      |
      v
[编排画布]  元素识别 → 自动组件名(anchor) + 手动 alias
      |     拖移 / 缩放 → 记录 manipulation（几何真值 + 意图文本，两者绑定）
      |     框选 → 命名分组（绑定共同 DOM 祖先 / 共同 anchor.component）
      v
首轮 diff（目标布局 vs 当前渲染）
      |
      +--> change-request.md + implementation-prompt.md
      |
      +--[授权闸门]--> agent 直接改前端源码（默认需显式授权，见 §3.4）
      |
      +--> [可选] 参考站点：打开外部站 → 探针抽 computed style → style-target.json
                   （设计 token 级，独立分层，不与元素级 annotation 混流，见 §3.3）
      v
recapture → revision diff → review.html 复审 → verdict → consolidate → 下一轮
```

---

## 3. 四个必须先定的设计决策

### 3.1 直接操纵存在语义鸿沟——几何必须与意图文本绑定

这是整个改造里**最容易做错的一点**。

浏览器里拖出来的是 **CSS px delta**，但源码里的真相是 `flex` / `grid` 的 `gap`、`order`、`flex-basis`、`margin`。给 agent 一个 `x +32px`，它很可能翻译成 `margin-left: 32px` 这种脆弱代码，或者在响应式下直接失效。

具体约束：

1. **拖拽/缩放的 annotation 必须强制填写意图文本**，否则该 annotation 不可导出。裸 delta 是噪声，不是指令。
2. **`resize` 的翻译提示要显式给 agent**：宽度变化在响应式布局下通常应落到 `flex-basis` / 列数 / 断点，而不是 `width`。现有 `intent.breakpoint`（`all/current/desktop/tablet/mobile`）正好承载这个语义，要在 prompt 里强制携带。
3. **`manipulation.before` 必须取自真实捕获几何**，不是截图像素。`review-loop.md:147-148` 已经做对了（rect 来自 inventory）。首轮前移时必须保持这一点。
4. **delta 必须锚到 element `key`**（alignment identity），不是绝对坐标。否则第二次捕获就失去对应关系。现有 `manipulation` 结构里 `key` 已经在用，别破坏。
5. **拖拽后的「目标布局」在 DOM 里不存在**。它是用户手摆的期望状态，必须始终标记为 `expected` 而不是 `observed`，否则 diff 会把它当成既成事实。

### 3.2 分组必须绑定 DOM 祖先或共同组件，而不是屏幕上的矩形

对 agent 有意义的分组是「**这些元素都在 `ProductGrid.tsx` 里**」，不是「这三个框在屏幕上挨着」。

- 分组在创建时计算：所有成员是否共享同一个 DOM 祖先 / 同一个 `anchor.component` / 同一个 `anchor.file`。
- 若能确定共同祖先 → 分组携带 `containerKey` 与 `container.anchor`，prompt 里可以写「在 `<container>` 内统一调整」。
- 若不能确定（成员分散在多个组件）→ 明确标记为 `mixed`，prompt 里逐个列出，**不允许** agent 自行猜一个容器。
- `scope: repeated` 已经存在（按 `key` 应用到所有同 key 实例，`annotation-schema.md:162-163`），分组要与它对齐，不要造第二套批量语义。

### 3.3 参考站点反推设计：既然能注入探针，就不要靠截图

既然边界放开到「允许任意外部网站并注入探针」，**最精确且不依赖多模态模型的做法是直接读 computed style**：

- 在参考站点上遍历目标子树，采集 `color / background-color / font-size / font-weight / line-height / padding / margin / gap / border-radius / box-shadow / border-width`。
- 做**统计聚类**（按频次排序的取整直方图），得到该站点真实的 token 值，而不是猜。
- 输出 `style-target.json`：色板、间距阶梯、圆角阶梯、字阶、阴影、层级，每项带**出现频次**作为置信度代理。
- 截图只作为人看的视觉参照保存，**不进入模型**。

**分层是硬要求**：参考设计是设计意图（token 级），元素 annotation 是当前页面的事实（DOM 级）。两者混进同一份 prompt，agent 会分不清「这是这个页面的现状」还是「我想要的样子」。

因此产物独立：

```text
<session>/
  reference/
    style-target.json        # token 级，带频次
    style-target.md          # 人类可读的设计意图
    ref-<host>-<n>.png       # 仅视觉参照
```

prompt 合成时显式声明优先级与来源，冲突时**报告而不静默选一个**（与 `SKILL.md:28-29` 里既有的「Do not resolve a conflict between two instructions on the same target」保持一致）。

### 3.4 授权边界：从「只读观察者」到「受控写入者」

现有 `SKILL.md:28-31` 明确：

> Do not resolve a conflict... / Stop after generating the change specification unless the user separately asks to implement the approved changes.

一旦要让 skill 直接交给 agent 改前端代码，它就从只读观察者变成写入者，以下保证需要重新表述（不是删除，是重新划界）：

- 「Write only the annotation session bundle」→ 变成「写 session bundle + 经授权的源码改动」；
- 「Do not install dependencies or modify the target application to inject the toolbar」→ 注入工具栏仍然不许，但**源码编辑授权后允许**；
- 「Recapture reads the page; it never edits the target application」→ 保持。

**默认保持人工闸门**：生成 change request → 用户确认 → 才允许改码。新增显式授权（如 skill 层的 `implement: approved` 状态或参数），而不是把自动改码设为默认。理由：diff 出来的像素意图本来就不可靠（§3.1），自动应用会把不确定性直接写进代码。

---

## 4. Schema v1.3 变更

当前是 `1.2`（`annotation-schema.md:9`）。新增字段全部为**可选增量**，1.2 会话仍可读。

### 4.1 Annotation 新增

```json
{
  "id": "A1",
  "alias": "HeaderCard",          // 新增：用户手动命名，可空
  "revisionId": "rev-001",
  "kind": "element",
  "manipulation": { "mode": "move", "before": {}, "after": {}, "delta": {} },
  "intent": {
    "operations": ["layout"],
    "expected": "…",              // 直接操纵时改为必填（§3.1 约束 1）
    "scope": "element",
    "breakpoint": "all"
  }
}
```

`alias` 规则：
- 非空时必须是会话内唯一标识符（建议 `^[A-Za-z][\w-]{0,63}$`），冲突时报错而不是静默改名；
- 校验失败不阻断会话，降级为警告并保留原 `id`；
- 显示层优先用 `alias`，它进 prompt 时**同时携带** `id` 与 `anchor`，不是替代。

### 4.2 Session 新增

```json
{
  "groups": [
    {
      "id": "G1",
      "name": "Hero 区",           // 手动命名
      "annotationIds": ["A1", "A2"],
      "containerKey": "…",          // 共同祖先的 element key，可为 null
      "container": { "anchor": { "file": "src/Hero.tsx", "line": 12, "component": "Hero" } },
      "cohesion": "container"       // container | component | mixed
    }
  ],
  "reference": {
    "styleTarget": "reference/style-target.json",
    "sources": [{ "url": "https://example.com", "capturedAt": "…" }]
  }
}
```

`cohesion` 就是 §3.2 的判定结果，必须落到 schema 里，否则 prompt 无法区分「统一调整」和「逐个调整」。

### 4.3 迁移

- 读入 1.2 会话：`alias`/`groups` 视为空，`reference` 视为 null；
- 写出时若含新字段则标记 `version: "1.3"`；
- `scripts/validate-session.mjs` 是唯一校验入口，新增校验集中在那里（现在 `normalizeIntentOperations` 就在这里，是既有模式，照做即可）。

---

## 5. 分阶段落地

### P0 — 手动命名 + 命名分组（最小改动，收益最大）

**为什么先做**：schema 纯增量，`symbol-index` / `revision-diff` 完全不用动，但 prompt 质量立刻上一个台阶；同时兜住 §1.3 的降级场景。

改动点：

| 文件 | 改动 |
|---|---|
| `references/annotation-schema.md` | 加 `alias`、`groups[]`、`cohesion` 定义与规则 |
| `assets/overlay.js` | 意图面板加「名称」输入；框选批量后加「建组 + 命名」；分组管理列表 |
| `scripts/validate-session.mjs` | 校验 alias 唯一性与字符集、groups 引用完整性、cohesion 枚举 |
| `scripts/build-change-spec.mjs` | `:191-210` 的 annotation 段落加 alias 行；`:301` 的 prompt 行加分组归属；新增分组小节 |
| `scripts/consolidate-review.mjs` | 折叠轮次时**保留** alias 与 groups（现在 `:131-134` 用 operations+expected 判重，要保证 alias 不丢） |
| `references/prompt-contract.md` | 明确：引用用 `alias`，但**必须**同时给出 `id` 与 anchor；分组带 `cohesion` 语义 |

验收：
- 命名一个元素 → 出一版 change request → alias 出现在人类请求与 agent prompt 两处；
- 框选 3 个同组件元素建组 → prompt 里出现「在 `<container>` 内统一调整」；
- 框选 3 个跨组件元素建组 → prompt 里标记 `mixed`，逐个列出，不含容器推断；
- 走完一轮 consolidate，alias/groups 仍在。

### P1 — 首轮直接操纵（拖移 / 缩放前移）

改动点：

| 文件 | 改动 |
|---|---|
| `scripts/start-session.mjs:327-334` | bootstrap 目前只注入 `config + overlay.js`。为了在首轮算出与 inventory 一致的 `key`，需要**同时注入 `assets/inventory-probe.js`**（或把 key 算法抽成共享模块，两处都引） |
| `assets/overlay.js` | 加 `move` / `resize` 工具，操作实时元素；`before` 取 `getBoundingClientRect()`；写 `manipulation`；**强制要求 `intent.expected`**（§3.1） |
| `assets/review.html` | 复用现有画布逻辑（`:604-669`），不要复制一份。目标是两处共用同一套操纵代码路径 |
| `references/annotation-schema.md` | 明确 `manipulation` 可出现在首轮 annotation，不只复审 |
| `scripts/build-change-spec.mjs` | 把 `manipulation.delta` 渲染成「几何真值 + 语义提示（gap/order/flex-basis）」两块，并强制带 `breakpoint` |

**关键实现约束**：现有 `inventory-probe.js` 只被 `capture-revision.mjs:33` 注入（复审期），首轮 overlay 用的是自己的 `targetAt()` 实时 DOM。首轮操纵要在两个上下文里得到**同一个 key**，这是 P1 的核心工作量。**建议抽共享模块**，而不是复制算法——`key` 漂移会让 diff 对齐失败，属于静默错误。

验收：
- 首轮拖动一个元素 → change request 里出现 `manipulation` 与强制填写的 `expected`；
- 未填 `expected` 时**无法导出**，并给出明确提示；
- 首轮记录的 `key` 与 `capture-revision` 产出的 inventory `key` **一致**（要有断言测试）；
- 复审画布仍能正常工作（回归）。

### P2 — Handoff 授权（策略改动，几乎零代码）

改动点：

| 文件 | 改动 |
|---|---|
| `annotate-web-ui/SKILL.md:28-31` | 重写边界条目（§3.4）：保留人工闸门为默认，新增显式授权路径 |
| `references/prompt-contract.md:39-40` | 「The generated prompt is not approval to edit」需要区分「未授权」与「已授权」两种措辞 |
| `references/review-loop.md:183-190` | Boundaries 同步更新 |

验收：未授权时行为与现在完全一致（回归测试）；显式授权后才允许 agent 改码。

### P3 — 外部站点探针 + 参考设计反推（最重）

改动点：

| 文件 | 改动 |
|---|---|
| `scripts/start-session.mjs:117` | `assertReachableLocalUrl` → 扩为三级来源策略（§6） |
| `scripts/start-session.mjs:610` | `isAllowedLocalUrl(overlayState.url)` 门控 `printReady`，改为按来源级别判定 |
| 新增 `scripts/extract-style-target.mjs` | 参考站点 token 抽取 + 频次聚类（§3.3） |
| 新增 `references/reference-design.md` | 分层规则、冲突报告规则 |
| `assets/overlay.js` | Trusted Types 兼容（见 §6.3），overlay 现在用 innerHTML，严格站点上会崩 |
| `references/prompt-contract.md` | 增加 `## Reference design` 分层小节，显式声明来源与优先级 |
| `scripts/validate-session.mjs` | 校验 `reference` 段 |

验收：
- 打开一个外部站点 → 探针注入成功 → token 抽取产出带频次的 `style-target.json`；
- 在 Trusted Types 站点上 overlay 不崩（用 `createElement` 或注册 policy）；
- 参考设计 + 元素 annotation 同时存在时，prompt 里**分两节**，冲突被报告而非静默解决。

---

## 6. 外部网站的边界重写

### 6.1 三级来源策略

把现在的「只允许本地」改成带级别的来源：

| 级别 | 来源 | 默认 |
|---|---|---|
| `repo` | 仓库内静态目录 / HTML | 允许，沿用 `scripts/static-site.mjs`（loopback） |
| `local` | `localhost` / `127.0.0.1` / `[::1]` / `*.localhost` | 允许，沿用现有校验 |
| `external` | 其他任何 HTTP(S) origin | 允许，但需显式指定，且带 §6.2 约束 |

`http://` 外部站点建议仍拒绝（明文传输 + 无意义），除非显式覆盖。

### 6.2 隐私

外部站点可能包含用户的登录态、个人信息、内部数据，而现有边界是「never upload a screenshot」。新增约束：

- **截图永不离开本机**这条保持不变，且要在外部站点下更醒目地提示；
- 账号类站点默认启用更强的遮挡提示，`redact` 工具在外部站点下默认前置；
- **绝不读写 cookie / localStorage / sessionStorage**（`annotation-schema.md:206-210` 已经禁止写入 artifact，这里要扩大到禁止读取）；
- 注入的 overlay 不得把页面内容发往任何网络；
- 会话 artifact 里若包含外部站点的 URL，视为敏感信息。

### 6.3 注入风险

| 风险 | 说明 | 处理 |
|---|---|---|
| Trusted Types | overlay 现在用 innerHTML（如 `overlay.js:1586` 附近的工具面板），严格站点会抛错 | 改为 `createElement` 构建，或注册 Trusted Types policy |
| 页面已有同名 host | overlay 用 `#__symbui-host` + shadow DOM（`overlay.js:1244`），隔离尚可 | 进入前检测冲突，冲突则报告 |
| 页面事件劫持 | 站点可能 `preventDefault` / 阻止键盘快捷键 | 快捷键走 CDP 侧兜底 |
| 页面频繁重渲染 | SPA 会在重渲染时清掉 overlay DOM | 依赖 `Page.addScriptToEvaluateOnNewDocument`（已有，`:599`）+ MutationObserver 兜底 |
| 站点 ToS | 自动化访问可能违反条款 | 提示用户，由用户决定，不代做判断 |

### 6.4 传输层结论（重要）

CDP binding 通道（`Runtime.addBinding: __symbuiNative`）在外部 origin 上**照常工作**：
- 不受 CORS 限制（不是 fetch）；
- 不受混合内容拦截（不是 http 子资源请求）；
- 不受页面 CSP 限制（`Runtime.evaluate` 是 DevTools 侧执行）。

所以 P3 里**没有通道重写工作**，风险集中在 §6.3 的注入兼容性与 §6.2 的隐私策略。

---

## 7. Prompt 合成分层

`implementation-prompt.md` 变为分层结构：

```text
## Change set (元素级)
  - 每组：alias / id / anchor / manipulation(几何真值) / expected / breakpoint / invariants
  - 分组带 cohesion: container | component | mixed

## Reference design (token 级，可选)
  - 来源 URL 与捕获时间
  - 色板 / 间距 / 圆角 / 字阶 / 阴影，每项带频次
  - 声明：这是设计意图参考，不是当前页面现状

## Precedence
  - 元素级标注的显式指令 > 参考设计
  - 冲突必须报告，不得静默取舍

## Resolver
  - 沿用既有：声明解析引擎与降级情况（prompt-contract.md:9-13）
```

`## Resolver` 那一段的设计理由值得保留并推广：**一个静默降级的 resolver 比一个失败的更糟**。同样适用于参考设计——降级必须写在 prompt 里。

---

## 8. 测试计划

复用现有框架（`node --test tests/*.test.mjs`，真实 Babel/Vue/Vite + 隔离 Chrome）：

| 阶段 | 新增测试 | 说明 |
|---|---|---|
| P0 | `tests/alias-groups.test.mjs` | alias 唯一性校验、groups 引用完整性、cohesion 判定（共享祖先 → container / 跨组件 → mixed） |
| P0 | 扩展 `tests/revision-diff.test.mjs` | 确认 alias/groups 不参与 diff 对齐（它们不该影响 alignment） |
| P1 | `tests/first-pass-manipulation.test.mjs` | **首轮 key 与 capture-revision 产出的 key 一致性断言**（P1 的核心正确性） |
| P1 | 扩展 `tests/drive-smoke.mjs` | 首轮拖动 → 导出 → change request 含 manipulation |
| P2 | 授权门测试 | 未授权时行为与现状完全一致（回归） |
| P3 | `tests/external-site.test.mjs` | **用本地另起一个不同 origin 的 HTTP server 模拟外部站点**，不要依赖公网 |
| P3 | Trusted Types fixture | 一个开启 TT 的本地页面，验证 overlay 不崩 |
| P3 | `tests/style-target.test.mjs` | token 抽取与频次聚类（纯函数，易测） |

原则：外部站点测试必须**离线可复现**（本地模拟），否则 CI 必然 flaky。

---

## 9. 明确不做的事

- ❌ **不做所见即所得的页面编辑器**。不真拖拽生成布局代码——响应式下像素真值不存在，必然产出脆弱 CSS。现有「标注意图 → agent 改源码」的路线是对的，保持。
- ❌ **不生成像素级 CSS**。`manipulation.delta` 是证据，不是要写进源码的值。
- ❌ **不静默安装依赖、不静默改构建配置**（`plugins/` 注入器必须继续是「问用户」而不是默认）。
- ❌ **不静默解决冲突**（两条指令打同一目标时报告，不选边）。
- ❌ **不在 P0/P1 阶段碰参考设计**。分层没设计好就混流，只会污染 prompt。

---

## 10. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| 拖拽 delta 被 agent 误译成脆弱 CSS | **高** | §3.1：强制意图文本 + 显式给 gap/order/flex-basis 提示 + 必须带 breakpoint |
| 首轮 key 与 inventory key 漂移 | **高** | 抽共享模块 + 断言测试（P1 核心工作量） |
| 直接操纵逻辑在 overlay 与 review.html 两份实现里漂移 | 中 | 复用，不复制；`overlay.js` 已 1763 行、`review.html` 已 1369 行，再加一套必然失控 |
| 参考设计与元素标注混流污染 prompt | 中 | 分层 + 冲突报告（§3.3 / §7） |
| 外部站点注入破坏对方页面 / 违反 ToS | 中 | shadow DOM 隔离 + 提示用户 + 不代做判断 |
| Trusted Types 站点 overlay 崩溃 | 中 | 去 innerHTML 或注册 policy |
| overlay.js / review.html 继续膨胀 | 中 | P1 定为「收敛」而非「新增」：共用操纵代码路径 |
| 自动改码把不确定性写进代码 | 中 | 默认人工闸门（§3.4） |

---

## 11. 工作量相对估计

| 阶段 | 相对量 | 说明 |
|---|---|---|
| P0 alias + groups | 小 | schema 增量 + 校验 + 两处渲染；不碰管线 |
| P1 首轮操纵 | 中 | 核心是 key 共享，不是 UI |
| P2 授权 handoff | 很小 | 主要是文档与策略 |
| P3 外部站点 + 参考设计 | 大 | 策略重写 + TT 兼容 + 新增抽取脚本 + 分层 prompt |

建议顺序：**P0 → P1 → P2 → P3**。P0 独立可交付且立刻改善 prompt；P1 依赖 P0 的 alias 才能让人读懂操纵结果；P3 最重且改动面最广，放最后。

---

## 附：改动文件总览

```text
annotate-web-ui/
  SKILL.md                          # 边界重写（P2）、工作流更新（P0/P1/P3）
  assets/overlay.js                 # alias 输入、建组、move/resize 工具、TT 兼容
  assets/review.html                # 复用操纵路径（P1，不新增实现）
  assets/inventory-probe.js         # 抽出 key 算法供两处共用（P1）
  scripts/start-session.mjs         # bootstrap 注入 probe（P1）、三级来源策略（P3）
  scripts/validate-session.mjs      # alias/groups/reference 校验（P0/P3）
  scripts/build-change-spec.mjs     # alias/分组渲染、manipulation 语义提示、分层 prompt
  scripts/consolidate-review.mjs    # 折叠轮次保留 alias/groups
  scripts/extract-style-target.mjs  # 新增：参考站点 token 抽取（P3）
  references/annotation-schema.md   # v1.3
  references/prompt-contract.md     # 分层 + 授权措辞
  references/review-loop.md         # Boundaries 同步
  references/reference-design.md    # 新增：参考设计分层规则（P3）
tests/
  alias-groups.test.mjs             # 新增（P0）
  first-pass-manipulation.test.mjs  # 新增（P1）
  external-site.test.mjs            # 新增（P3，本地模拟外部 origin）
  style-target.test.mjs             # 新增（P3）
```

---

## 实现状态：P0 / P1 已完成

### 已交付

**P0 — 手动命名 + 命名分组**

| 文件 | 改动 |
|---|---|
| `references/annotation-schema.md` | schema 升到 `1.3`：`annotation.alias`、`session.groups[]`（含 `cohesion`）、`session.reference`，以及 direct-manipulation 的三条规则 |
| `scripts/validate-session.mjs` | alias 唯一性/字符集（**只警告，绝不改写用户输入**）、groups 引用完整性（悬空 id 为**错误**）、cohesion 枚举、container 必须带 `containerKey`、`reference` 形状 |
| `scripts/build-change-spec.mjs` | 两份产物都渲染 alias（**与 id 和 anchor 并列，不替代**）、`## Groups` 小节（三种 cohesion 各自措辞，`mixed` 明确禁止虚构容器）、manipulation 渲染为两块 |
| `scripts/consolidate-review.mjs` | 跨轮保留 alias/groups；关闭的成员从分组移除，空分组丢弃，cohesion 不重算 |
| `references/prompt-contract.md` | 上述条款写入契约 |
| `tests/alias-groups.test.mjs` | 新增 12 个纯 Node 测试 |

**P1 — 首轮直接操纵**

| 文件 | 改动 |
|---|---|
| `assets/inventory-probe.js` | `collect()` 内部把 node→key 映射缓存下来，新增 `window.__SYMBUI_KEY_FOR__`（**同一代码路径查表**，沿 `parentElement` 回退到最近已捕获祖先） |
| `scripts/start-session.mjs` | bootstrap 改为 `[config, probeSource, overlaySource]`，首轮即可用探针 |
| `assets/overlay.js` | 「移动」「缩放」工具（真实元素、`getBoundingClientRect()` 取 before）、alias 输入、命名分组 + 分组管理、`expected` 强制闸门、payload 携带 alias/manipulation/groups |
| `tests/first-pass-manipulation.test.mjs` | 新增 3 个真实 Chrome 测试，核心断言是 `__SYMBUI_KEY_FOR__` 与 inventory 的 key **完全相等** |

同时更新：`SKILL.md`（工作流与 Runtime behavior 反映首轮编排与命名/分组）、`scripts/lib/session.mjs`、`scripts/model-client.mjs`、`assets/review.html`（版本号）。

### 与文档写法的偏差（都有理由）

1. **schema 版本号做了一次全量升版**，而不是只加字段：`lib/session.mjs` 的 `SCHEMA_VERSION` 从 `1.2` → `1.3`，`model-client.mjs`、`review.html` 的 payload 字面量同步。理由：文档声明 1.3，且读入方已接受 1.0–1.3，留着旧版本号会让文档与代码互相矛盾。
2. **顺带收紧了 `intent.operations` 的完整性规则**：原规则只在 `schemaVersion === "1.1"` 时要求 `operations` 是数组，升版后等于对所有真实会话失效。改为 `!== "1.0"`。理由：这是我升版造成的严格性回退，必须补上，否则该检查变成死代码。
3. **`expected` 闸门被实现了两次**：overlay 在结束会话时阻止（用户可见提示），`build-change-spec` 把它列入 unresolved。另外校验器本身也把缺失 `expected` 视为致命错误，所以渲染器那道是纵深防御而非唯一防线。
4. **`resize` 用按下时的象限（4 个角）而不是 review.html 的 8 个手柄**；delta/before/after 的算法与 `operations: ["layout"]` 预设跟随 review.html。
5. **分组成员用勾选框从当前活动状态的标注里选**（overlay 没有持久化多选状态；框选仍然只产出一个 box 标注）。

### 新发现的既有缺陷（本次有意未修，超出 P0/P1 范围）

`validateSessionDirectory` 只校验**首轮旧结构**。对已经过捕获归一化的会话（含 `revisions`/`rounds`）会误判：

```text
ERROR: states must contain at least one captured page state.
ERROR: annotations must contain at least one annotation.
```

影响：`SKILL.md:127` 记载的"编译中断后重跑校验/重编译"这条恢复路径，以及任何在复审轮次之后重跑 `buildChangeSpec` 的调用，都会失败。复现：先用 `node tests/review-loop-demo.mjs` 生成演示会话（demo 产物已被清理），再运行
`node annotate-web-ui/scripts/validate-session.mjs .workbuddy-ai/demo/review-loop/session`。

**不能靠"归一化后再校验"简单修掉**：state id 按 schema 要求**必须跨 revision 稳定**（"State IDs must be stable across revisions"），所以把多 revision 的 states 扁平合并会报出大量**假的重复 id 错误**（我用扁平化试过，正是这个结果）。正确的修法是让 id 唯一性按 revision / round **分作用域**校验，同时允许已捕获的 revision 没有 `annotatedImage`（复审捕获只产出 before 图，`annotatedImage` 为 `null`）。这是一次独立的校验器语义重设计，建议单独排期。

### 验证证据（全部实际运行）

- `node --test tests/*.test.mjs` → **171 测试，111 通过，0 失败，60 跳过**（基线 156/96/0/60；跳过的是需要 `node_modules` 里 Babel/Vue/Vite 的套件，仓库无 `node_modules`，属预期）。
- 新增测试 15 个：`alias-groups.test.mjs` 12 个（纯 Node）+ `first-pass-manipulation.test.mjs` 3 个（真实 Chrome，本机已安装）。
- `node --check` 对 8 个被改的 js/mjs 文件全部通过（overlay.js 是注入页面的脚本，语法错误会静默失败，所以这一项必须过）。
- **端到端走真实产物链路**（`validateSessionDirectory` → `buildChangeSpec` → 两份产物）跑一个首轮旧结构 + `schemaVersion: "1.3"` 的会话，含 alias、manipulation 和一个 `cohesion: component` 分组，实测确认：
  - alias 与 id、anchor 并列出现：`- A1 (HeaderCard) @ fixture.js:3 (exact): …`；
  - manipulation 渲染成两块——几何真值（含 `key`、before/after/delta，单位 CSS px）+ 语义提示（明确要求用 `gap`/`order`/`flex-basis`，并强制携带 `breakpoint: desktop`）；
  - `## Groups` 按 cohesion 措辞渲染，`component` 分支给出"按该组件统一调整"而不是虚构容器。

### 尚未开始

P2（handoff 授权边界）与 P3（外部站点探针 + 参考设计分层）未动。注意 P3 放开外部站点时，`validate-session.mjs` 的 `isAllowedLocalUrl` / `LOCAL_HOSTS` 以及 `start-session.mjs:117` 的 `assertReachableLocalUrl` 是同一处策略，需一并重写为三级来源（见 §6.1）。

### 第二轮：对抗性审查发现的缺陷与修复

第一轮交付后做了一次只读的缺陷优先审查，找到并修掉了 3 个真问题（另修复 4 个小问题）。以下都是**已修**的：

| 严重性 | 缺陷 | 修法 |
|---|---|---|
| 高 | **`consolidate-review.mjs` 完全没有导出闸门**——它把 `round.reviewAnnotations` 和 re-issued 标注直接渲染进下一轮产物，于是裸 delta 能经"复审往返"这条路进入 prompt，绕过 `build-change-spec` 和 overlay 的闸门。`serve-review.mjs` 的 `/save` 也不校验，任何非浏览器 POST 都能把裸 delta 写盘 | 在 `main()` 里、写出任何产物之前做阻塞判定：带 `manipulation` 且 `expected` 为空的标注一律列出 id 并终止，不写产物、非零退出。只对带 manipulation 的标注严格，普通标注保持原有宽松渲染 |
| 高 | **`__SYMBUI_KEY_FOR__` 的"祖先回退"被当成了元素自身的身份**。inventory 超过 `MAX_ELEMENTS = 4000` 被截断时（`stats.truncated` 被忽略），或冻结期间 DOM 被定时器/HMR 替换后，被拖元素会拿到**父容器的 key**，`manipulation.key` 静默指向容器 | 探针新增 `__SYMBUI_KEY_INFO__` 返回 `{ key, exact }`，`exact` 仅在元素**本身**命中缓存表时为真；overlay 只接受 `exact: true`，失败时重新 collect 重试一次，仍失败则**拒绝记录**并提示，页面不改动 |
| 中 | `manipulation.key` 既非必需也不被校验；`review.html` 明明手里已有 key（`app.drag.key`，来自 inventory）却没写进 manipulation | `key` 从 1.3 起为必需（1.0–1.2 只警告，兼容历史轮次）；`mode` 限 `move`/`resize`；`delta` 四个字段必须为有限数值；`review.html` 补写 `key` |
| 中 | 分组的勾选跨冻结状态泄漏：切状态后旧选中项不可见却仍进组，还能让 `computeCohesion` 用当前 DOM 算出错误的"同一容器" | 状态切换/分组重渲染时把 `groupSelection` 收敛到当前 state 的标注 id |
| 中 | `computeCohesion` 按"第一个匹配项"定位元素，重复组件的多个实例共用同一 anchor，于是**各自在不同容器**里的两个成员被判定成 `container`——正是 `mixed` 分支要禁止的"替 agent 编一个容器" | 命中多个候选时用 `target.rect` 最近邻消歧；歧义无法消解则降级 `mixed`，绝不猜容器 |
| 低 | `pointercancel` 被绑到提交路径，触摸/触控板接管会把最后一次坐标落成真标注 | 新增取消路径（清状态、隐藏 draft、不提交），只有 `pointerup` 提交 |
| 低 | alias 占位符给的是中文示例，而校验器对中文 alias 会警告——用户照提示填就吃警告 | alias 占位符改为 ASCII 示例；分组名保持自由文本（可为中文）。契约里补充说明这个不对称：alias 会写进 prompt，故建议 ASCII 标识符；分组名是人类标签 |
| 低 | `normalizeSession` 无条件改写 `schemaVersion`，`"9.9"` 也被照常处理并重写成 `1.3`，"这不是我的格式"的信号丢失 | 版本存在但不在支持集合内时抛错；缺失仍按 `1.0` 处理（保留历史行为） |

审查同时确认**干净**的方面：key 同源性（不存在第二份 key 算法）、overlay/probe 无任何网络请求与 storage/cookie 读写、既有框选/点/箭头/遮挡工具未被破坏、alias/groups 跨轮存活与悬空 group 校验、cohesion 的降级方向（拿不到探针即 `mixed`，不瞎猜）、版本号写入端与读入端自洽。

第二轮后：**178 测试，118 通过，0 失败，60 跳过**。新增测试覆盖了 consolidate 闸门（真实子进程断言非零退出 + 无产物落盘）、key 的必需性与向后兼容、cohesion 判定本身（共享祖先 → `container`；分散在不同容器 → `mixed`；探针不可用 → `mixed`）、非精确 key 时 overlay 拒绝记录、`pointercancel` 不提交。

### 第三轮：UI 风格改造（Dia Browser 视觉语言）

范围：把两套 UI 统一到 `DESIGN_1_.md` 指定的 Dia 语言。**只改样式与呈现，不改功能**。

| 文件 | 改动 |
|---|---|
| `assets/overlay.js` | 首轮标注浮窗整块 CSS 重写 + 面板 markup + 绘制/画布导出色；**默认紧凑**（356×670，正文区不滚动）并在头部新增「密度」按钮切到舒适密度；页面标注改为黑描边 + lime 底、遮挡用 void black、移动/缩放用 saffron |
| `assets/review.html` | 整个 `<style>` 块重写（复用同一套 token）；6 种 diff 标记在调色板内重映射（ink/carbon/slate/silver/saffron/lime + 3px 墨色描边保证浅底可读）；画布框选/拖动改为黑描边 + lime、激活用 saffron |

关键 token 落地：bone `#f8f8f8` 纸面 / `#ffffff` 卡片 / `#efefef` linen 填充 / 纯黑 1px 实线主要层次 / 圆角只用 {12,20,24,9999} / 等宽 13px 大写 + 1.3px 字距作小标题 / 只过渡颜色类属性 0.2s（无 hover 位移）/ 光谱渐变各用一次 / 不加载任何网络字体（脚本会注入任意页面且须离线可用）。

**有意不采纳**：112px display、80px 段落间距、2.19 正文行高、1200px 页宽——那是营销页的页面级节奏，套到 356px 紧凑浮窗与 380px 复审侧栏上会不可用。这是明确的取舍，不是遗漏。

#### 两个必须记住的运行事实（都是实测踩出来的）

1. **首轮浮窗的按钮"消失"问题不是代码缺陷。** 用户实测看不到「移动/缩放」，实际是那份 `~/.pi-desktop/scratch/feb09461-.../skills/annotate-webui/` 的**整仓快照（Sep 18 14:02:58、58905 字节、4 个工具）早于 P1 落地 1.5 小时**；仓库当前版本（15:30:21、85240 字节）6 个工具齐全且实测全部可见。skill 是按 session 快照的，所以**新开 session 才会拿到当前仓库**。
2. **复审 UI 改源文件是生效的，但不要直接服务 demo 产物。** `scripts/review-session.mjs:126` 会把源 `assets/review.html` 拷进轮次目录，所以运行时看到的就是源文件。而 `review-loop-demo.mjs` 生成的复审判次目录里那份 `review.html` 是**生成时的产物**——第一次独立验证时我直接服务了它，量出来仍是旧配色（body `#f6f6f4`、按钮 `#185fa5`、圆角 8px），差点误判成改造没生效。验证时必须先把源文件拷进被服务的目录（`.workbuddy-ai/demo/` 下的产物已清理，需要时用 `node tests/review-loop-demo.mjs` 重新生成）。

#### 验证证据（独立复跑，非子代理自述）

- `node --test tests/*.test.mjs` → **178 测试 / 118 通过 / 0 失败 / 60 跳过**；`node --check` overlay.js 通过；review.html 的 39KB 内联 JS 提取后 `node --check` 通过；旧配色在两份文件里残留均为 0。
- 首轮浮窗（真实 Chrome 探针）：面板 356×670、正文 `scrollHeight == clientHeight == 542`（**不滚动**）、6 个工具全部 `visible:true`；激活工具 saffron `rgb(255,220,92)`、未激活 linen `rgb(239,239,239)`、圆角 9999px。
- 首轮**行为**回归（补齐了原本无人覆盖的路径）：真实 Chrome 里「冻结 → 画框 → 选改动类型 → 填预期 → 完成并生成」跑通，框选几何精确为 `300,300,120×80`，导出产出真实带标注 PNG（638,762 字符的 dataUrl）。顺带确认漏选「想改什么」时导出被守卫正确拦下。
- 复审 UI（真实 Chrome）：两个 pane、3 张图（1280×800）全部加载；四种对比模式逐一验证（`.pane` 类分别变为 `mode-slider` / `mode-blink` / `mode-heatmap`，热力图 `.heat` 变 `display:block`）；`review.json` 成功加载（状态行显示「直接改动 11 处 · 连带位移 22 处」）；无控制台错误；所有 `border-radius` 落在允许集合内；主按钮黑底白字 20px 字重 650、卡片白底 12px + 1px 纯黑、选中态 lime 胶囊（切换后确认 `aria-pressed="true"` 的按钮底色为 lime，其余 linen）。

### 第四轮：复审 UI 的三处缺陷修复

| 严重性 | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| 高 | **选「标注类型」后画不出任何形状** | kind 处理器强制 `app.tool = "inspect"`，而 pointerdown 里两个 inspect 分支（有元素→选中、无元素→清空）**先于** kind 分支消费了按下事件，所以绘制分支永远不可达 | 把标注变成真正的模式：工具行新增「标注」按钮；选类型即进入该模式（`app.tool = "annotate"`）；pointerdown 最先解析 annotate 分支；删掉原来那段不可达的 kind 兜底代码 |
| 中 | **点位标注点完看不见**（点不出现、侧栏不更新） | `addAnnotation()` 只记录标注 + 切 tab，`switchTab()` 也只切 class，两者都不重新渲染，而其它绘制路径都会显式调用 `render()` | 点位分支补上 `render()` |
| 高 | **右侧缩放/拖动不可用：手柄与页面右带被侧栏盖住**（本轮新发现） | `render()` 只给可标注 pane 设了计算宽高，只读的「修改前」pane 没有尺寸，其图片按固有宽度撑开 → 行溢出画布区 252px（实测 pane1=726 / pane2=506，而画布区仅 1028 宽、侧栏从 x=1060 开始），可标注 pane 的右侧 204px 落到侧栏之下 | 抽出 `withSize()`，让两个 pane 使用同一计算尺寸（实测 506 / 506，行宽正好 1028），右侧手柄回到 x=860 且命中元素是手柄本身 |

第三处是**改造前就存在**的缺陷，不是样式改造引入的：证据是我直接对比了真正的改造前基线（父提交 `7383635`）——那时只读 pane 同样没有尺寸（`pane.style.width` 在该文件里只出现 1 次，且仅针对可标注 pane），而 `.canvas-row` / `.pane` 的布局规则在改造前后逐字相同。它也解释了为什么之前只验证了「8 个手柄存在」，却没人验证过「拖动手柄能生效」。

验证：用真实 CDP 输入事件（合成 PointerEvent 会让 `setPointerCapture` 抛错，测不出真实行为）跑了 **13/13** 项检查——点位即刻渲染（DOM 里 `.anno-dot` 与侧栏卡片在同一次交互内出现）、方框经类型行可绘制、**拖动 se 手柄产出 resize 标注**（`hitHandle: "se"`）、以及四项回归（查看仍能选中且不产生标注、框选仍能批量选中、拖动仍记录 move、无控制台错误）。测试套件 **178 / 118 通过 / 0 失败 / 60 跳过**，review.html 内联 JS 提取后 `node --check` 通过。

### 第五轮：让缩放手柄真正可用

**手柄的显示是双重门控的**——必须同时满足：

1. `app.selection.length === 1`（**恰好选中 1 个元素**）；
2. `app.tool === "resize"`（工具为**缩放**）。

选中一个元素的两种途径：用「查看」点击页面元素，或在侧栏「本轮变更」里点一条聚类卡片。两者之后再点「缩放」，8 个手柄（`nw n ne e se s sw w`）才会出现在该元素的四角与四边中点。

**但即使出现了也几乎用不了**：手柄尺寸写死为 8 个 viewBox 单位，在默认「适应」缩放下只有 **3.14 px**、描边仅 **0.6 px**——看上去就像没有，也点不中。

修法：手柄尺寸改为按屏幕像素恒定（视觉 11px、抓取区 24px，除以 `scale` 换算回 viewBox 单位）；视觉方块设 `pointer-events: none`，其下方叠一个透明抓取矩形承载 `data-handle` 与方向光标，于是抓取区比视觉标记大一倍多。

| 缩放 | 缩放比 | 视觉尺寸 | 抓取区 | 中心命中 |
|---|---|---|---|---|
| 适应 | 0.394 | **10.92 px**（原 3.14） | **23.83 px** | `handle-grab se` |
| 100% | 0.998 | **10.97 px** | **23.94 px** | 视口外（100% 下页面宽于画布区，需横向滚动） |

拖动抓取区仍产出 `mode: "resize"` 的 manipulation；13/13 绘制与回归检查通过，测试套件 178 / 118 通过 / 0 失败 / 60 跳过。

注意 100% 缩放下手柄会落到可见画布之外——这不是缺陷：1280px 宽的页面放进 1028px 宽的画布区本来就需要横向滚动才能看到右边缘。

#### 放宽显示条件 + 抓取区按元素尺寸封顶

按用户裁决，手柄的显示条件从「恰好选中 1 个元素 **且** 工具为缩放」放宽为**只看选中数量**（`if (app.selection.length === 1)`）——任意工具下选中 1 个元素即显示 8 个手柄。

这带来一个必须一并处理的顺序问题：手柄在**标注**模式下也会显示，但 pointerdown 原本把标注分支放在最前，会出现"看得见却按不动"。于是把**手柄判定提到所有分支之前**——可见即可用：在标注模式下抓到手柄就是缩放，其余位置照常绘制，代价只有那 8 个小区域。

另外，把抓取区固定放大会撞上一个新问题（被我自己的回归测试当场抓到）：**薄元素的抓取区会横跨元素内部**。实测那个 363×39 的元素在适应缩放下只有 15.4px 高，而 24px 的抓取区让它的**中心点也落在 `s` 手柄的抓取区内**，于是"拖动元素"被解释成了 resize（回归输出从 `move` 变成 `resize`）。修法：两个尺寸都按元素自身的屏幕短边封顶——

```
markPx = clamp(shortSide * 0.5, 6, 11)
grabPx = clamp(shortSide * 0.6, 8, 24)
```

实测：薄元素在适应缩放下 mark 7.65 / grab 9.18（它的中心点重新可点，拖动恢复为 move）；同一元素在 100% 下短边 38.9px 已不触发封顶，mark 10.97 / grab 23.34；大元素在任意缩放下为 11 / 24。

验证：手柄门控 **9/9**（五种工具各 8 个手柄、手柄优先于「拖动」、无选中与多选皆为 0）+ 绘制回归 **13/13**，测试套件 178 / 118 通过 / 0 失败 / 60 跳过。

### 第六轮：面板钉扎（A 方案——面板不再压在页面上）

**问题**：面板是注入进页面的（`overlay.js` 把 `#__symbui-host` 挂在 `document.documentElement`，面板 `position: fixed`），所以它盖住的每一像素都是标不了的像素。356×670 的面板压在右上角，被压住的元素既看不见也点不到。

**方案取舍**：曾评估四条路——A 页内改良、B 独立 Chrome 窗口（面板搬出页面、loopback 通道中继）、C 宿主侧栏（PI-Desktop work panel）、D 原生悬浮窗（macOS `NSPanel` 置顶）。用户先取 **A**：改动最小（一个文件），且无论后续是否做 B/D，用户都需要一个能临时挪开面板的开关。

**行为**：头部新增「钉扎」开关，与「密度」开关同构（`font-size: 0` + `::before` 画字、`aria-pressed` 表状态、按下态 saffron `#ffdc5c`）。字形显示**当前生效的状态**：`钉` = 钉扎固定显示，`浮` = 浮动自动收起。

| 状态 | 默认 | 行为 |
|---|---|---|
| 钉扎（`aria-pressed="true"`） | ✅ | 面板始终完整展开，与改造前完全一致 |
| 取消钉扎（`"false"`） | | 指针一回到页面就收起为**状态栏**，回到面板区域不再自动展开 |

**收起/展开规则**（未钉扎时）：

| 触发 | 反应 |
|---|---|
| `pointermove` 落在页面上（composed path 不含面板） | 从**第一次**触发算起 420ms 后收起 |
| `pointerdown` 落在页面上 | **立即**收起（光标由浏览器自己移走：按下别处本来就会移焦点，不需要我们额外 `blur()`） |
| 指针在面板内（`panel.matches(":hover")`） | 不收起，并取消待执行的收起 |
| 面板内 `input/textarea/select` 持有焦点 | 暂停收起——不能在打字中途把输入框收走 |
| 拖动面板头部中（`app.panelDrag`） | 暂停收起 |
| 点右侧 `+`，或再次点「钉扎」 | 显式展开 |
| 新建标注（`createAnnotation`）或校验失败要用户补填 | 代码驱动地展开并把光标放进对应输入框 |

**刻意不做悬停展开**：展开会因 `clampCurrentPanel` 重新定位而改变面板矩形，于是"指针离开面板→收起→矩形回到指针下→展开"可能自激振荡。收起只由页面侧事件驱动，展开永远是显式点击，就不会形成回环。代价是收起后要先点一下 `+`。

**收起形态**：沿用既有的 `.panel.collapsed`，但补一条——收起时隐去文字标识与 eyebrow，只留品牌徽标 + 状态胶囊：

```css
.panel.collapsed .title strong,
.panel.collapsed .title .eyebrow { display: none; }
```

不加这条时，296px 宽度下标题换行成两行，收起高度 97px；加上后回到 `min-height` 的 48px。实测：

| 状态 | 面板矩形 | 盖住页面面积 |
|---|---|---|
| 钉扎 | 356×670 @ (910,14) | 238,520 px² |
| 取消钉扎后指针回到页面 | **296×50** @ (970,14) | **14,800 px²（−93.8%）** |

头部不溢出（`scrollWidth - clientWidth = 0`），面板内所有控件在 356px 内均可容纳（标题实测 171px）。

**指针是否在面板上，读的是浏览器自己的命中测试**（`panel.matches(":hover")`），不维护任何缓存标志。审查后改的：初版用 `pointerenter/pointerleave` 维护 `app.pointerOverPanel`，而一次漏掉的边界事件就会让状态永久跑偏（指针捕获期间、冻结时面板被 `display: none`、resize 把面板从静止指针下移走），要么永远不再收起，要么在指针还按在面板上时把它收走。`:hover` 没有可漂移的中间状态。

**第一次触发即定**：`schedulePanelCollapse` 在已有待执行定时器时直接返回，不做「取消并重排」。初版每次页面 `pointermove` 都重排，于是语义变成「鼠标停下 420ms 后才收起」——手一直动，面板就一直压在页面上。

**两个实现陷阱（都被测试当场抓到）**：

1. 第一次插入接线代码时落点多了一行，整块落进了「密度」按钮的回调内部——于是监听器只在点过密度之后才挂上。用 CDP 的 `getEventListeners`（`includeCommandLineAPI: true`）确认 `panel: {}`、`document: {keydown: 1}` 才定位到。
2. 26px 图标按钮的**左上角**正好落在自身边缘，CDP 点击在像素取整后会落到头部 padding 上，于是「点钉扎」什么也没发生。测试的点击一律取元素**中心**。

**提交前的对抗性审查（3 个中等缺陷，全部已修）**：

| 缺陷 | 症状 | 修法 |
|---|---|---|
| 收起定时器每次页面 `pointermove` 被重排 | 语义变成「鼠标停下 420ms 才收起」，手一直动面板就一直压着页面 | 首次触发即定，已有待执行定时器则不再排 |
| 用 `pointerenter/pointerleave` 维护指针状态 | 漏一次边界事件就永久跑偏：要么再也不收起，要么在指针还按在面板上时收走 | 改为读 `panel.matches(":hover")`，取消该状态字段与两个监听器 |
| 收起态下 `expected.focus()` 空转 | 未钉扎用户画完标注后，光标没进说明框，后面敲的字进了页面 | `focusPanelField()`：先展开面板再聚焦，覆盖 4 处自动聚焦调用点 |

被审查纠正的一处误判：原以为 `onPagePointerDown` 里显式 `blur()` 是必需的，实测（测试 1 当场失败）发现**按下页面别处时浏览器本来就会移走焦点**，`blur()` 是冗余代码，已删除；`onPagePointerDown` 因此缩成「非面板就 `collapsePanel()`」，钉扎守卫由 `collapsePanel` 自身承担。

三条关键断言都做了**变异验证**（把实现改回缺陷形状，确认测试真的会红）：重排定时器 → 用例 2 失败；`focusPanelField` 去掉展开 → 用例 5 失败。时间线实测：未钉扎且指针持续移动时，面板在起始移动后 **≈420–480ms** 收起（而不是等手停下）。

**测试**：新增 `tests/panel-pin.test.mjs`（5 个用例，真实 Chrome + 真实鼠标事件）：默认钉扎且页面移动/按下都不收起、取消钉扎后回到页面收起且原被盖住的点恢复可点、输入框有焦点时收起被抑制而页面按下立即收起且已输入文字不丢、`+` 与「钉扎」两条显式展开路径、未钉扎下画完标注自动展开并把光标放进说明框。测试套件 183 / **123 通过** / 0 失败 / 60 跳过。

**没做的事**：面板仍在页内，只是不再常驻遮挡；真正的"悬浮于桌面"（B/D）未做，`app.pinned` 也**不做持久化**（注入代码禁止读写 storage），每次会话默认钉扎。

### 第七轮：macOS 原生悬浮窗（D 方案）

**目标**：把控制面板从被标注的网页里搬到一个**原生的、始终浮在其他窗口之上**的 macOS 窗口，让浏览器视口完整还给标注。

**为什么这一轮能做成 A 做不到的事**：A（钉扎/自动收起）只是让面板"不常驻遮挡"，面板仍在页内、仍受页面坐标系约束。悬浮窗要成立，面板必须变成**独立表面**，于是需要一条页面 ↔ 面板的数据通道。

**架构（四块）**：

| 部件 | 文件 | 职责 |
|---|---|---|
| 页面侧指令面 | `assets/overlay.js`（新增约 230 行） | `__SYMBUI_PANEL_STATE__()` 导出可序列化快照；`__SYMBUI_PANEL_COMMAND__(cmd)` 把 18 条指令分发到**页内面板同一批函数**（`chooseTool`/`toggleFreeze`/`setOperation`/`updateSelectedIntent`/`createGroup`/`finishSession`…） |
| 中继 | `scripts/panel-host.mjs`（新，239 行） | loopback HTTP：`/panel.html` 提供面板页、`/events` 以 SSE 推快照、`/command` 收指令转 CDP、`/hello` 记录面板已加载 |
| 面板页面 | `assets/floating-panel.html`（新，1636 行，自包含） | 由快照渲染的面板 UI，`?demo=1` 可离线预览 |
| 原生壳 | `scripts/native/panel.swift` + `build-panel.mjs`（新） | `NSPanel`（`level = .floating`、`canJoinAllSpaces`、accessory 无 Dock 图标）+ `WKWebView` 加载中继页面；`swiftc` 按需编译，零下载 |

**关键取舍**：

- **页面侧仍然零网络请求**：面板 ↔ Node 走 SSE/HTTP，Node ↔ 页面走会话已有的 CDP 与 `__symbuiNative` binding。注入代码的不变量没被破坏。
- **中继对网页不可用**：只绑 `127.0.0.1`，每条路由都要会话 token，且**从不发 CORS 头**——网页即使猜到端口也读不到响应、发不出 JSON POST。
- **单一状态源**：指令走页内面板原有的函数，所以两个表面不会各存一份 intent。`toggleOperation` 与新增的 `setOperation` 合并成一条路径。
- **状态推送是 250ms 轮询 + 变更去重**（仅在面板已连接时轮询），不是改 overlay 的每条渲染路径——用最小侵入换取"页面上拖一下，悬浮窗 250ms 内跟上"。
- **`--float` 时页内面板默认收起**（`config.floatPanel` → `pinned = false`）：同一批控件已经在桌面上，页内那份只需不挡路。
- **页内 toast 同步到悬浮窗**：`showToast` 现在额外发 `panel-toast`，由中继转成面板的 toast。否则"完成并生成"被闸门拦下时，用户盯着的那块屏幕会毫无反应。

**实测（生产路径，非测试替身）**：

```
SYMBUI_FLOAT_PANEL=http://127.0.0.1:58272/panel.html?token=2372c…fb84
SYMBUI_PANEL_HELLO=1
SYMBUI_PANEL_READY http://127.0.0.1:58272/panel.html?token=2372c…fb84 level=3
SYMBUI_PANEL_WINDOW=ready
```

`level=3` 即 `NSFloatingWindowLevel` 裸值；`PANEL_HELLO=1` 证明 `WKWebView` 不只是取回了页面，而是**执行了页面里的 JS**。会话结束时窗口与浏览器一起退出（`pkill` 后 `pgrep symbui-panel` 为空）。loopback 明文 HTTP 未被 ATS 拦截，无需例外配置。

**测试**：新增 `tests/floating-panel.test.mjs`（3 个用例，全绿）：中继无 token / 错 token 一律 403 且无 CORS 头、未知指令返回 `{ok:false}`；面板页作为**真正的第二视图**驱动页面（面板点冻结 → 页面冻结；页面拖框 → 面板 15s 内自行出现该标注；面板点选 → 页面选中；点「完成并生成」→ 页面的拒绝原文出现在面板 toast；在面板打字 → 写进页面的 intent，且回传快照不会吃掉已输入的文字）；原生窗口加载真面板（`level=3` + `/hello` 到达 + SIGTERM 干净退出）。

**踩到的三个坑（都在测试里留下了断言）**：

1. `/json/new?url=<编码后的完整 URL>` 会丢掉 `?token=`，面板页因此永远"连接中"——测试改为先开空白页再 `Page.navigate` 到确切 URL，并断言 `location.search` 里确实有 token。
2. 被标注页一旦退到后台就**拿不到帧**，而 `requestCapture()` 要等两次 `requestAnimationFrame`，于是"点冻结没反应"。测试改为给面板页**单独一个浏览器实例**（也更贴近现实：悬浮窗本来就是独立窗口）。
3. 测试的 `waitFor(client, expr, "说明文字")` 把说明文字当成了超时毫秒数 → 截止时间 `NaN` → 条件明明成立却立刻失败。helper 的第三个参数改为消息。

**没做的事**：面板页与页内面板是**两套 DOM 实现**（同一个设计语言、同一份快照契约，但渲染代码不共享）；`--float` 只在 macOS 生效，其他平台只打印 `SYMBUI_FLOAT_PANEL` 让人用浏览器打开；窗口位置记忆用 `UserDefaults`，不随会话走。
