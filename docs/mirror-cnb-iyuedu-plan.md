# 收录 CNB 仓库 mingwuyan/iyuedu 到 legado-wiki 的方案

> 本文档只做**研究**，不执行任何改动。待你确认后再落地。
> 对应 CNB 仓库：https://cnb.cool/mingwuyan/iyuedu

---

## 一、项目是什么

`mingwuyan/iyuedu` 是开源阅读（Legado）的一个**二次开发分支卷**，托管在腾讯 CNB（cnb.cool）代码托管平台上，而不是 GitHub。

- 主页：https://cnb.cool/mingwuyan/iyuedu（公开仓库，44 个 commit，默认分支 `main`）
- 内容：在 Legado 基础上做了朗读脚本、猫箱 WebSocket、角色编辑、AI 生图等改造（从提交信息可见），**有原创代码**，符合本 wiki「有原创代码的分支」收录标准。
- 发布方式：**没有 Git Release / Tag（均为 0）**。APK 是本地构建的，源码按时间戳打包成 `legado_app_x.x.xxxxxx.tar.gz` 提交在仓库 `releases/<时间戳>/` 目录里（例如 `releases/202605151222/legado_app_3.26.051512.tar.gz`）。仓库里还有 `build_*.log` 构建日志。

这三点决定了它**没法像其它 GitHub 分支那样直接接入现有体系**（详见下文）。

---

## 二、关键事实（已实测确认）

1. **CNB 公开仓库支持匿名 git 读取**。
   - `git ls-remote https://cnb.cool/mingwuyan/iyuedu.git HEAD` → 返回 `2b82880f…`（无需登录）。
   - `git clone --depth 1 https://cnb.cool/mingwuyan/iyuedu.git` → 匿名拉取 2333 个文件，成功。
   - 这意味着「用 GitHub Action 定时去拉」可行，**不需要 CNB 账号/令牌**。

2. **CNB 的 Git 地址格式**：直接用仓库页面 URL，支持 `.git` 后缀。
   - 例如 `https://cnb.cool/mingwuyan/iyuedu.git`。
   - 认证方式为访问令牌（用户名固定 `cnb`），但**公开仓库读取无需认证**；只有写入（push）才需要。

3. **CNB 的 OpenAPI（api.cnb.cool）所有接口都要 `Authorization: Bearer <token>`**，匿名拿不到仓库元数据。**所以我们做更新检测用 git 协议即可，不用向量 CNB API。**

4. **现有 legado-wiki 体系完全依赖 GitHub API**：
   - `scripts/fork-versions.mjs`：用 GitHub 的 `POST /repos/{o}/{r}/forks`（fork）和 `POST /repos/{o}/{r}/merge-upstream`（同步）把各分支备份到 `legado-backup` 组织。**这套 fork / merge-upstream 只对 GitHub 仓库有效，CNB 仓库用不了。**
   - `scripts/update-data.mjs`：用 GitHub 的 `GET /repos/{o}/{r}`（star / 更新时间 / 归档）和 `GET /repos/{o}/{r}/releases`（版本号 / APK / 更新日志）生成 `data/branches.json`。**它只能读 GitHub Release，CNB 没有 Release，喂不进去。**

结论一句话：**CNB 仓库想“无缝”挂进现有的 fork 备份 + release 展示体系是做不到的**，需要给它单独做一条「GitHub 镜像 + git 匿名拉取更新」的路径。

---

## 三、推荐方案（总思路）

核心：**先把 CNB 仓库镜像成一个用户自己的 GitHub 仓库，再用现有体系去管理这个镜像**；更新检测用「匿名 git 拉 CNB 上游 → 对比 commit → 有更新则 push 到镜像仓」。

```
CNB 上游 (匿名 git 可读)
   │  GitHub Action 定时 git fetch/ls-remote 对比 HEAD commit
   ▼
用户 GitHub 镜像仓库（新增，例如 CCSSNE/iyuedu 或 legado-backup/iyuedu-mirror）
   │
   ├─ 纳入 branches.json → fork-versions 继续自动备份/告警
   └─ 纳入页面展示（阅读分支卡片）
```

### 3.1 一次性：建立镜像仓库

两种方式任选其一：

- **方式 1（推荐，用 Action 做镜像）**：新建一个 GitHub 仓库（或直接建在 `legado-backup` 组织下，如 `legado-backup/iyuedu`），用来存放 CNB 上游的完整历史。
- **方式 2（手动兜底）**：本地 `git clone --mirror https://cnb.cool/mingwuyan/iyuedu.git`，再 push 到用户 GitHub 仓库。用于首次初始化。

### 3.2 新增一个「CNB 同步 workflow」（关键新增）

`fork-versions.yml` 只处理 GitHub 仓库，对 CNB 同步要**新增一个独立 workflow**（例如 `.github/workflows/sync-cnb-iyuedu.yml`），逻辑与 `fork-versions.mjs` 区分开：

```
schedule: 定时（可与现有一致，如每小时）
steps:
  1. 匿名 git ls-remote https://cnb.cool/mingwuyan/iyuedu.git HEAD
     → 得到上游最新 commit
  2. 与本地记录的上次 commit（存文件，如 data/iyuedu-upstream-head）对比
     - 相同 → 无更新，结束
     - 不同 → 有更新，继续
  3. git fetch（匿名拉取 CNB 上游，保留完整历史）
  4. 更新 GitHub 镜像仓库：
     - 若上游历史是线性快进 → 直接快进 push
     - 若上游历史被 force push / rebase → 保全镜像不覆盖，发告警邮件
     （这正是现有 fork-versions.mjs 里 isFastForwardable 的设计，可复用同样的思路）
  5. 更新记录文件 data/iyuedu-upstream-head，提交回 wiki 仓库
```

> 用 **commit 对比**而不是文件 diff。这个项目是大型 Android Kotlin 工程（2000+ 文件），做文件级 diff / 合并几乎不可行且易冲突；`ls-remote HEAD` 一次网络请求就能判断「是否有更新」，最稳。

### 3.3 纳入现有体系

- 在 `data/branches.json`（/ `scripts/update-data.mjs` 的 branches 数组）新增一条，`repo` 指向**用户的 GitHub 镜像仓库**（而不是 CNB 地址）。
  - 这样 `update-data.mjs` 能正常读 star、更新时间；
  - `fork-versions.mjs` 能正常把它备份/同步到 `legado-backup`。
- **Release 需要单独处理**（见 §3.4），因为 CNB 没有 GitHub Release。

### 3.4 Release / APK 展示的处理（需要你拍板）

其它分支的“版本号 + APK 下载 + 更新说明”全部来自 GitHub `/releases`。CNB 这份没有 Release，APK 是本地构建、源码以 `.tar.gz` 提交在仓库里的。所以镜像过去后 GitHub 镜像仓库**默认没有 release**，页面会显示“无公开 Release，源码长期未更新 → 自动判为弃坑”（update-data.mjs 的弃坑判定逻辑会这样触发）。

可选处理：

- **方案 R1（推荐，最简单）**：页面不主动给这个分支发 APK / release，接受“仅源码收录”，并在 `note` 里说明“APK 需本地构建（仓库 releases/ 目录有源码 tar.gz）”。若被误判弃坑，给这条记录写 `manualAbandoned` 之外的方式规避——具体是让 update-data 支持“无 release 也不算弃坑”的标记（需小改 `update-data.mjs`）。
- **方案 R2**：在 GitHub 镜像仓库里手工维护 release（每次同步后把最新 `.tar.gz` 建一个 GitHub Release 指向）。工作量大，不太建议。
- **方案 R3**：用 CNB 的云原生构建产物 + 手动搬运 APK。需要 CNB 构建配置和账号，复杂，不建议。

---

## 四、已确认的决定（用户拍板）

| 项 | 决定 |
|---|---|
| 定位 | **当作独立分支收录**（不做资源挂靠、不做特殊处理） |
| 镜像仓库 | `legado-backup/iyuedu`（放现有备份组织下，与其它 fork 备份一致） |
| Release 展示 | 仅源码收录（R1），不维护 APK；小改 `update-data.mjs` 支持“无 release 不判弃坑” |
| 同步频率 | 每小时 + 手动触发（与现有 `fork-versions` 一致） |
| 保护策略 | 沿用现有 `isFastForwardable`：CNB 上游若 force-push / 历史重写，**不覆盖镜像、报错 + 发告警邮件**，哈希/对比照旧 |

### 最终待确认参数（落地前请过目）

1. **新分支元信息**（决定列表排序 / 显示名 / 评论区 giscus 串）：
   - `id: "iyuedu"`，`name: "阅读 iYueDu"`，`tag: "iyuedu"`，`term: "legado-branch-iyuedu"`
   - 可改为你喜欢的中文名或缩写。
2. **note 写法**：建议「分叉自 Sigma（Luoyacheng/legado-E）的独立版本；源码镜像自 CNB mingwuyan/iyuedu」。可接受？

（z阅读 那条描述确认与本站无关，仅作注释，不参与收录。）

---

## 五、与“手动 diff / 本地重新上传”的对比

| 方案 | 优点 | 缺点 |
|---|---|---|
| **Action 匿名拉取 + 镜像（推荐）** | 全自动、定时、commit 级可靠；复用现有 fork 备份/告警 | 需先建镜像仓 + 新增一个 workflow |
| 手动：`git clone` CNB → push 到 GitHub | 简单、无需写代码 | 每次更新都要人工操作，容易忘 |
| 本地 `git diff` 对比 | 直观、可只挑改动 | 2000+ 文件工程 diff 慢、冲突多，无法自动化成定时任务 |

综合：**先做一次手动镜像/初始化，之后用 Action 自动跟踪更新**，是收益最大的路径。

---

## 六、待办清单（确认后执行）

- [ ] 建 GitHub 镜像仓库（或 legado-backup 组织下的仓库）
- [ ] 首次把 CNB 完整历史 clone → push 到镜像仓
- [ ] 新增 `.github/workflows/sync-cnb-iyuedu.yml` + 一个 `scripts/sync-cnb.mjs`（复用现有 isFastForwardable 思路）
- [ ] 在 update-data 的 branches 数组加条目（repo 指向镜像仓）+ 可选的无 release 不弃坑标记
- [ ] 建 `data/iyuedu-upstream-head` 记录文件并纳入 git
- [ ] 本地跑一遍 update-data / fork-versions 干跑（含告警邮件配置复用）
- [ ] push 后验证页面出现新分支卡片

---

## 附：血统分析（基于完整克隆 main 分支 + 所有候选分支文件哈希对比）

**结论：i阅读 分叉自 Sigma（Luoyacheng/legado-E），不是原版、也不是其它分支。** 这是一个**独立版本**，按独立分支处理收录。

### 取证一：Git 历史被重写，git 层面追不到上游

44 个 commit 全部是作者自己的改造（朗读 / AI 生图 / 角色管理 / 猫箱 WebSocket），首个 commit 就是 `3a464bd 初始化:iYueDu 朗读脚本与资源`，**没有任何 `merge(upstream)` / fork 来源提交**。所以只能靠「文件树与各候选分支的哈希重合度」定位血统。

### 取证二：文件级哈希对比（权威）

把 i阅读 的 `app/src/main/java` 与 `app/src/main/res` 下所有文件，和 6 个候选分支当前 HEAD 按「相对路径 + git blob 哈希」求交集和相同率（blob 哈希即文件内容哈希，不下载内容）：

**java 源码，交集内相同率（越高越像）：**
| 分支 | 交集内相同 |
|---|---|
| **Sigma（legado-E）** | **76.1%** |
| NG | 63.0% |
| 原版备份 | 62.9% |
| MAX | 60.2% |
| 阅读C | 54.4% |
| MD3 | 43.5% |

**res 资源，交集内相同率：**
| 分支 | 交集内相同 |
|---|---|
| **Sigma（legado-E）** | **91.5%** |
| 原版备份 | 82.7% |
| NG | 82.4% |
| MAX | 73.9% |
| 阅读C | 66.6% |
| MD3 | 30.7% |

对照组：Sigma vs 原版备份 java 交集内相同 65.5%、res 81.7%——**i阅读 与 Sigma 的重合率（76.1% / 91.5%）甚至高于 Sigma 与原版本身（65.5% / 81.7%）**，这在数学上说明 i阅读 不是独立平行分叉，而是 Sigma 的紧密下游。

### 取证三：分叉方向 + 独有改造（钉死“Sigma 下游”）

- **i阅读 独有文件（55 个）**全部是它的自研功能：`TtsScript*`（朗读脚本）、`BgmAI*` / `BgmManager` / `BgmKeywordMatcher`（AI 背景音乐）、`AiImage*`（AI 生图）、`CharacterManagerDialog` / `DialogRoleManager` / `CharacterVoiceHelper`（角色管理）、`TtsEngineActivator` / `TtsWebSocketHelper` / `JsWebSocketConnection`（tts/WebSocket 朗读）等。
- **Sigma 独有但 i阅读 没有（仅 3 个）**：`ReplaceBook.kt`、`RegexJsExtensions.kt`、`ArrayListExtensions.kt`——Sigma（legado-E）这几个是它的标记性文件，i阅读 一个都不含。
- **两边都有但内容不同（207 个）**：是 i阅读 在这些上游公共文件上叠加了改造（TTS、角色、朗读手势、隐藏状态栏等，与 44 个 commit 对应）。
- **数据库 schema**：i阅读 = **99**，Sigma 当前 = **89**。i阅读 在 Sigma 基础上又自加了约 10 个 schema 迁移（对应 TTS脚本 / 角色 / AI生图 / 背景音乐 新表）。Sigma 自身**不含**任何 `TtsScript*` / `BgmAI*`（各 0 个）。

### 结论

血统：**原版 Legado → Sigma（Luoyacheng/legado-E）→ i阅读（mingwuyan/iyuedu）**。
i阅读 = Sigma + 自研「朗读脚本 / 角色管理 / AI 生图 / AI 背景音乐 / 猫箱 WebSocket」改造，作者可能从 Sigma 较早阶段分叉后独立演进（schema 已到 99，超过当前 Sigma 的 89）。

用户此前“大概率不是原版、可能是 Sigma 系列”的判断**得到确认**。

### 其它背景（供 note 参考）

- 应用名 `app_name = "i·阅读"`，`app_name_s = "LegadoPlus"`（原版共存版命名）。
- 仓库内散落大量 `.js/.json/.md` 朗读脚本与配置（`千问接口.js`、`猫箱.js`、`朗读脚本_AI角色分析.js`…），以及 `role_annotation_feature`、`sound_effect_package`、`朗读脚本功能改造包`、`猫箱WebSocket支持改造包` 等改造包目录。
- 无 GitHub 式 Release/Tag；APK 本地构建，源码 tar.gz 按时间戳提交在 `releases/<时间戳>/`。
- `z阅读` 那条描述确认与本站无关，仅作注释，不参与收录。

### 确定的方向（用户已拍板）

1. **当作独立分支收录**（不是资源包、不是挂靠），note 可注明「分叉自 Sigma（legado-E）」。
2. **镜像备份 + 自动同步都要**：建 GitHub 镜像仓，`fork-versions` 系的「force-push / 历史重写保护 + 哈希对比 + 告警邮件」逻辑照搬，CNB 上游若强推也照样报错。
3. **仅源码收录，无 Release**：CNB 无 GitHub Release，页面不展示 APK 下载；小改 `update-data.mjs` 让它不至于因无 release 被自动判弃坑。
4. **每小时 + 手动触发**同步。
