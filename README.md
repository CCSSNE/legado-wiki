# Legado 分支索引

开源阅读分支聚合页，部署在 GitHub Pages 和 EdgeOne。

## 部署入口

- GitHub Pages: https://ccssne.github.io/legado-wiki/
- EdgeOne: https://legado.erchuang.online/

两个入口都绑定 `CCSSNE/legado-wiki` 的 `main` 分支。以后更新网页只需要提交并推送 GitHub 仓库，GitHub Pages 和 EdgeOne 会自动部署。

页面会在浏览器端读取定时同步的 GitHub 仓库信息与 Release，展示 Star、源码更新时间、版本、发布时间、更新说明、下载文件和下载入口。站长开发分支排在第一位，其余分支按 Star 数从高到低排列。

弃坑标记规则：没有公开 Release，或最新 Release 超过半年没更新，并且源码也超过半年没更新，才算弃坑；作者声明停止维护的，直接标记弃坑。

收录标准：有原创代码（且未被上游全部合并），并发布过 APK，即可视为独立版本，本站收录。

收录范围：主要是开源阅读的分支，以及其它与阅读有关的代表性开源软件。何为分支：代码主体仍是原版，或重构重写后仍承认阅读血统者。

## 评论区

评论区已接入 giscus。每个分支使用独立的 `term`，对应独立的 GitHub Discussions 讨论串。评论区默认折叠，点击对应软件的评论按钮后才加载。

## 推荐链接

底部包含源仓库。顶部显示交流群 `1004372141`（可点击跳转加群）：提交新软件、补充信息或纠错，也是阅读 C 交流群。原版和 Tauri 使用独立补档仓库的 Release 下载入口。

墨水  https://github.com/radiumCN/inkwell
夜讀  https://github.com/bennytsai1234/Night-Reader
墨境  https://github.com/keys-cherish/morealm-reader
Lumi  https://github.com/huangder/Lumi_Books
LightNovelReader https://github.com/dmzz-yyhyy/LightNovelReader



开元阅读（半闭源） https://github.com/miloquinn/open-reading
彩读  https://github.com/ssnangua/ColorTxt
macOS、Windows 和 Linux。


ReadCat https://github.com/read-cat/read-cat
Windows
Legado macOS 版本 https://github.com/Kequans/legado-for-mac-pub
亦搜 https://github.com/mabDc/eso
 安卓
 tv（大白版，感谢大白）
 ios（需要自签）
 windows（需安装vc++运行库 内置3个dll，不需要额外安装）
 Linux（需libsqlite3-dev）
 Macos


漫画阅读器不收 非中文系的不收
半开源会标注，闭源的也会标注，闭源且付费的也会标注。。
