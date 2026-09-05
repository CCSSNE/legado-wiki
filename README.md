# Legado 分支索引

开源阅读（Legado）各分支的**版本聚合 + 下载入口 + 评论区**，解决“分支太多、不知道下哪个、下载慢、想吐槽没地方说”的问题。

- GitHub Pages（原站）：https://ccssne.github.io/legado-wiki/
- EdgeOne（国内站）：https://legado.erchuang.online/

两个入口都跟 `CCSSNE/legado-wiki` 的 `main` 分支。平时改网页只需要提交并推送，两个站会自动重新部署。

本站是纯静态站（单个 `index.html` + `data/*.json`），所有动态内容都是浏览器端 `fetch` 数据文件渲染出来的，没有后端。

---

## 网站长什么样

从上到下是这样排的：

```
顶栏 Header（标题 + 本站开源地址 + QQ 交流群 1004372141）
GitHub 下载加速条（开关 + 代理源选择，记忆在 localStorage）
分支关系树（左：纯 Android / 右：有多平台版本，可筛选）
卡片流（每个分支一张卡片，按 Star 排序，站长版置顶）
推荐链接（源仓库、全版本集散地）
访问趋势（不蒜子累计数据的 ECharts 曲线，总量/增量 × 总/国内站/原站）
页脚（收录 / 弃坑 / 删除 / 血缘规则 + 最后同步时间）
右下角回到顶部按钮
```

### 1. 分支关系树

这是本站的核心导航，一眼看出“谁是谁的下游”。

- **左右两列**：左树只放纯 Android 分支；右树放“存在任何非安卓平台”的分支（Android/iOS/鸿蒙/Win/Mac/Linux/TV/WEB 的任意组合）。
  左列根是 `原版 → T / Beta喵公子 / Sigma…`；右列根是 `原版（灰组，多平台成员：MD3 / 薯条 / MR / 鸿蒙 / Tauri / macOS）/ 亦搜 / 开元 / ReadCat / 彩读 / Books`。纯 Android 的新分支放左树，有桌面/苹果/鸿蒙/TV/WEB 的放右树。
- **实线 / 虚线 / ↗**：实线 = GitHub 承认的 fork 关系（`fork === true` 且 `forkOf` 等于父仓库）；虚线 = 同源但不是 GitHub fork（重写、改名、换组织后独立发版）；`↗` = 外部仓库（补档库，不是分支本身）。
- **血缘 vs 展示位置**：谁是谁的后代只看 `index.html` 里的 `FAMILY` 表（`original → t/md3/main/sigma/shutiao/mr/harmony/tauri/macos`，`sigma → archive/max/ng/pp/x/jingshiro/m/i阅读`，`archive → r → c`，`max → max-sum/max-cichen`，`ng → 阅融`），跟放在左列还是右列无关。搬展示位不影响家族 Star 总数。右列顶上的灰色“原版”组通过 `familyOf: 'original'` 把 Star 计入原版家族。
- **排序**：补档节点（`external`）永远置顶；然后先实线后虚线；每组内部按**家族 Star（自身 + 全部后代 Star 之和）**降序。家族总数是展示无关的唯一依据，筛选只隐藏节点、不重排。
- **标签**：绿色小标是平台（安卓/iOS/鸿蒙/Win/Mac/Linux/TV/WEB）；红/黄/灰小标是状态：`弃坑 / 半开源 / 闭源 / 收费 / 不兼容书源`。
- **筛选**：上面两排 chips，“只看”按平台过滤，“不看”按状态过滤。补档附件跟随父节点，不参与平台筛选；被筛掉的父节点若还有存活子孙，会以灰字祖先形式保留。
- **交互**：`+ / −` 折叠子树；点击分支名跳到对应卡片（`#repo-<id>`）；滚动时当前可见的卡片在树里高亮。

### 2. 卡片（每个分支一张）

卡片分四段：

```
[头] 软件名 + tag + 仓库名 + Star + 置顶/弃坑标 + 源码更新时间 + 站长备注(note) + Fork补档/相关仓库行 + [仓库]按钮
[版] 最新 Release：标题 + 测试版徽 + 发布时间（绝对+相对） + 文件数 + 更新说明（markdown 简渲染） + 逐个下载行（文件名 + 大小 + 下载按钮）
[空] 无 Release 时显示原因（允许无 Release 的镜像仓除外）
[评] 每个分支独立评论区，默认折叠，点“评论”才加载
```

- **排序**：`阅读 C（站长开发，pinned）` 永远第一；其余按 Star 从高到低。Star 同步失败显示“Star 同步失败”并沉底。
- **Release**：只取各仓库最新的一个 Release（含预发布，会打“测试版”标）。原版和 Tauri 的上游已删库，卡片显示的是站长补档仓（`CCSSNE/legado`、`CCSSNE/Legado-Tauri`）的备份 Release，并注明来源。
- **下载行**：每个附件一行，显示大小（B/KB/MB/GB）。加速开关打开时，下载链接自动改写为 `代理前缀 + 原地址`，代理源（`gh-proxy.com / ghfast.top`）可切换，选择会记住。
- **Fork / 相关行**：原版、Tauri 显示 `Fork 补档`；i阅读显示 GitHub 镜像 + CNB 上游地址。`skipAutoForks` 的条目不自动拉 fork 列表。
- **评论**：giscus，每个分支一个独立 `term`（如 `legado-branch-c`），对应 `CCSSNE/legado-wiki` 的 Discussions 下独立讨论串。懒加载，收起/展开不丢已加载内容。

---

## 哪些是人工定的，哪些是机器自动的

| 事项 | 人工（长期固定，改代码才变） | 自动（每小时跑，数据文件里变） |
|---|---|---|
| 收录谁 | ✅ `scripts/update-data.mjs` 的 `branches[]` 名单 + `data/branches-static.json`（一次性探测的非 Legado 系代表作）。加新软件就是在这里加一行 | — |
| 放左树还是右树、跟谁缩进 | ✅ `index.html` 的 `treeLeft / treeRight`（含 `platforms / flags / external / gray`） | — |
| 谁是谁的后代（家族 Star 怎么算） | ✅ `index.html` 的 `FAMILY` 表 + 灰组 `familyOf` | 自动按表求和、排序 |
| 实线还是虚线 | 人工定父子，机器判线型 | ✅ 实线当且仅当 GitHub API 说 `fork:true` 且 `parent` 等于树上父仓库，否则虚线 |
| 平台绿标 / 状态标 | ✅ 人工标 `platforms` 与 `halfOpen/closed/paid/incompatible` | `abandoned` 可人工（`manualAbandoned`）可自动（见下） |
| 备注、tag、置顶、补档地址 | ✅ `note / tag / pinned / backupRelease / forks / upstreamUrl / allowNoRelease` 全手写 | — |
| Star、源码更新时间、是否归档、fork 关系 | — | ✅ 每小时调 GitHub API 回填（`update-data.mjs`） |
| Release 标题/时间/说明/附件 | — | ✅ 每小时取各仓最新一个 Release；原版/Tauri 取补档仓指定 tag |
| 弃坑标 | ✅ 作者声明停更的手写 `manualAbandoned` 直接判弃坑 | ✅ 无手写时按规则判：无公开 Release（且源码超半年没动，`allowNoRelease` 除外）算弃坑；或 Release 与源码**都**超半年没更新算弃坑（半年 = 183 天） |
| 卡片顺序 | ✅ 站长（`pinned`）置顶是人工的 | ✅ 其余按实时 Star 自动排 |
| fork 备份（`legado-backup` 组织） | ✅ 名单来自收录表（`backupRelease / skipAutoForks` 的跳过） | ✅ 每小时 `fork-versions.mjs`：没有就新建 fork，有就 `merge-upstream` 快进；上游历史被重写 / 删库 / 默认分支改名则**不碰备份 + 发邮件告警** |
| i阅读 CNB 镜像 | ✅ `data/cnb-sync.json` 的映射关系手写 | ✅ 每小时 `sync-cnb.mjs` 匿名读 CNB 上游 HEAD，经 `git-filter-repo --strip-blobs-bigger-than 100M` 过滤后快进式推到 `legado-backup/iyuedu`；重写/不可达则告警 |
| 访问趋势 | ✅ 展示逻辑（总量/增量，总/分站）手写 | ✅ 每小时 `update-stats.mjs` 分别查两站不蒜子累计值，记一条 `data/stats.json`；前端用 `原始值 − runs` 扣掉自动化查询自带的虚增 |
| 页脚规则文字 | ✅ 收录/弃坑/删除/血缘/排序/排除/标注文案手写 | “最后同步”时间自动填 `branches.json.generatedAt`（北京时间） |

一句话：**人工管“收谁、跟谁、怎么说”，机器管“现在多少 Star、最新版是什么、坏了没、备份跟上了没”**。

---

## 收录 / 弃坑 / 删除 / 标注规则（页脚原文 + 解读）

- **收录标准**：有原创代码（且未被上游全部合并），并发布过 APK，即可视为独立版本，本站收录。
- **收录范围**：主要是开源阅读的分支，以及其它与阅读有关的代表性开源软件。何为分支：代码主体仍是原版，或重构重写后仍承认阅读血统者。
- **收录排除**：漫画阅读器不收，非中文系的不收。
- **源码标注**：半开源会标注，闭源的也会标注，闭源且付费的也会标注。（另有“不兼容书源”标）
- **弃坑标记**：没有公开 Release，或最新 Release 超过半年没更新，并且源码也超过半年没更新，才算弃坑；作者声明停止维护的，直接标记弃坑。（`allowNoRelease` 的源码镜像仓、手动补档仓不受此限）
- **删除原则**：Star 不超过 50 个，且满足弃坑标记规则，且没有符合收录标准的下游分支的，从本站删除。
- **删除说明**：删除仅指从本站页面上移除该条目，其补档保留不删除，站长会备份在自己的仓库里。
- **分支树血缘**：谁是谁的下游、是否补档，由人工裁定、长期固定。
- **分支树线型**：实线/虚线按 GitHub 实际 fork 数据自动更新。
- **分支树排序**：补档置顶；先实线后虚线；各组内按家族 Star（自身 + 全部后代）降序。

---

## 评论、加速、统计是怎么做的

- **评论（giscus）**：`repo=CCSSNE/legado-wiki`，`mapping=specific`，每卡一个 `term`。默认折叠防页面卡顿，点开才插 `<giscus-widget>`。想给某分支留言就点它卡片下的“评论”。
- **下载加速**：只改链接前缀，不经过本站服务器。开关状态与所选代理源存在 `localStorage`（`legado_accel / legado_proxy`）。
- **访问趋势**：页面每次加载会顺手给两站不蒜子各 +1（这是不蒜子的计数原理，页脚已不显示数字）。定时脚本每小时也各查一次，所以每条记录自带 `runs`（累计自动化查询次数），前端展示用“累计值 − 查询次数 × 站数”还原净数。可切总量/增量（增量 = 相邻两条净数之差），可切总访问量/国内站/原站。

## 推荐链接

- 源仓库：https://www.yckceo.com/（阅读书源相关入口）
- 全版本集散地：https://momoa.cc.cd/下载/xz（阅读多分支下载入口）
- 顶部交流群 `1004372141`（点击跳转加群）：提交新软件、补充信息或纠错，也是阅读 C 交流群。

---

## 数据与定时任务

```
index.html                  # 全部页面：树定义 + 渲染 + 筛选 + 评论 + 图表（唯一需要手改的前端）
scripts/update-data.mjs     # 收录名单（branches[]）+ 每小时回填 Star/Release/fork/弃坑 → data/branches.json
scripts/fork-versions.mjs   # 每小时把收录仓 fork/同步到 legado-backup 组织（备份），异常发邮件
scripts/sync-cnb.mjs        # 每小时把 CNB 上游同步到 GitHub 镜像仓（当前只有 i阅读）
scripts/update-stats.mjs    # 每小时记一条两站访问量快照 → data/stats.json
data/branches.json          # 自动生成：主名单实时数据（generatedAt 是最后同步时间）
data/branches-static.json   # 手工维护：非 Legado 系代表作，一次性探测写入，不进每小时同步
data/stats.json             # 自动累积：每小时一条 {time, runs, pv, uv, github:{}, edgeone:{}}
data/cnb-sync.json          # 半自动：CNB 镜像映射 + 上游 HEAD 记录
.github/workflows/update-data.yml    # cron 17 * * * *：update-data + update-stats + 提交
.github/workflows/fork-versions.yml  # cron 41 * * * *：fork 备份 + 异常邮件
.github/workflows/sync-cnb-iyuedu.yml # cron 23 * * * *：CNB 镜像 + 异常邮件
```

本地没有构建步骤，改完 `index.html / scripts / data/branches-static.json` 直接提交推送即可；`data/branches.json / data/stats.json / data/cnb-sync.json` 由 Action 每小时自己提交。

### 加一个新分支（站长操作）

1. `scripts/update-data.mjs` 的 `branches[]` 加一行（`id / name / tag / repo / term`，需要就加 `note`）。
2. `index.html` 的 `treeLeft / treeRight` 选一列挂上去（平台、归属家族），`FAMILY` 里登记父子。
3. 提交推送，等下一个整点（`:17`）自动同步 Star 和 Release；评论区 `term` 按 `legado-branch-<id>` 起名即可自动落到独立讨论串。

---

## 交流与纠错

- 提交新软件、补充信息或纠错：加 QQ 群 `1004372141`（也是阅读 C 交流群），或到本站开源地址 https://github.com/CCSSNE/legado-wiki 提 Issue / Discussion。
- 原版和 Tauri 使用独立补档仓库的 Release 下载入口，删库不影响下载。
