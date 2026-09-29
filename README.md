# 双向云桥 · OpenList Transfer

适用于 Windows 10/11 x64 的中文桌面工具：左侧夸克、右侧 115，通过本机缓存逐文件复制，保留源文件。发布包为一个便携 EXE，内置 OpenList v4.2.6；运行电脑不需要另装 Node.js、OpenList 或浏览器运行时。

## 使用

完整操作步骤见 [中文使用指南](docs/user-guide.md)；保存或打印可下载 [PDF 使用指南](output/pdf/OpenListTransfer-使用指南.pdf)。

1. 双击 `OpenListTransfer-1.0.0-x64.exe`，等待本地服务就绪。第一次启动会展开运行文件并初始化本机数据。
2. 在两侧分别点击“连接账号”，优先使用扫码 / 网页登录。程序会尝试导入夸克 Cookie 或 115 授权令牌；网盘页面变化、扫码风控或自动识别失败时，使用“手动凭证”：夸克填完整 Cookie，115 填 Access Token 和 Refresh Token。
3. 在“设置”选择有足够空间的缓存目录。在源盘选文件或文件夹，在目标盘进入所需目录，再点击中间的方向按钮并确认。
4. 任务区显示下载、上传、核验进度及失败原因。同名文件自动添加序号保留两份；同名文件夹合并，内部文件仍按上述规则处理。
5. 传输期间保持电脑开机联网。重新打开软件后，原任务保留，点击继续处理未完成文件；已记录完成的文件不会重新提交。

这是复制工具，不删除源文件。账号由用户本人在网盘官方页面登录，不附带账号、Cookie 或 Token。

## 实际边界

- **尚未使用真实夸克 / 115 账号完成端到端测试。** 已核查所固定版本两个驱动有上传和下载实现，但实际网盘接口、账号权限、容量、风控和会员条件可能使传输失败。第一次请先测试少量文件，确认目标内容可用。
- 文件先下载到本机，再交给目标网盘上传。网盘秒传能否命中由其服务决定，不保证秒传、免下载或固定网速。
- 大文件可能同时占用应用缓存和引擎哈希 / 上传暂存空间。空间检查按约 **2.1 倍当前文件大小加余量**估算；请选择空间充足的磁盘。完成并核验后清理本次文件缓存。中断或异常退出可能留下缓存，勿在任务运行时自行删除。
- 任务恢复依据本机任务记录，单个中断文件允许重新下载 / 上传；不承诺字节级断点续传。上传完成响应丢失等情况仍可能需要人工核对目标文件。
- 完成核验比较目录结构、文件数量和精确字节大小，**不等于内容哈希或逐字节校验**。重要文件请另作内容核验。
- 源盘内容在任务期间变化、外部程序同时修改目标、网页登录页面变化等情况可能造成失败。软件提供失败信息供重试，不保证同步这些外部变化。
- 当前发布文件未做商业代码签名；应从可信位置获取，并对照交付的 SHA256 检查完整性。

## 数据位置

程序配置、任务、OpenList 数据库和浏览器登录状态位于当前用户的应用数据目录，通常是 `%APPDATA%\OpenListTransfer`，可从“设置 → 打开数据目录”定位。缓存目录可单独选择。便携 EXE 仍需要写入这些本机数据，移动 EXE 不会自动迁移账号。

OpenList 仅监听 `127.0.0.1`，额外的 FTP、SFTP、S3、MCP 服务关闭。凭证保存在本机引擎数据库和浏览器登录状态中；任务记录、界面日志和源码包不应包含凭证。不要分享整个应用数据目录或将它上传到代码仓库；本项目不承诺凭证数据库具备额外的静态加密。

## 从源码构建

构建环境：Windows 10/11 x64、Node.js **22.12.0 或更高**（本次使用 24.19.0）、npm、系统 PowerShell。依赖通过 `package-lock.json` 固定；Electron 44.4.5，electron-builder 26.17.0。

```powershell
npm ci
npm run prepare:engine
npm test
npm run dev
npm run build:win
npm run archive:source
```

`npm run dev` 启动桌面窗口，关闭窗口后再继续执行构建。`prepare:engine` 从 OpenList 官方发布下载 v4.2.6 Windows amd64 ZIP，验证官方发布页给出的 SHA256，再提取 `vendor/openlist.exe`，并保存上游许可与对应版本源码归档。构建前再次核对 EXE 哈希。固定摘要与来源见 `vendor/manifest.json`。

输出：

- `release/OpenListTransfer-1.0.0-x64.exe`：便携分发文件。
- `release/OpenListTransfer-1.0.0-source.zip`：项目源码、锁文件、构建脚本、测试、说明和上游源码归档；不包含依赖缓存、构建输出或运行期账号 / 任务数据。
- `release/win-unpacked/`：构建中间目录，便于本地检查，不是单文件交付物。

下载及构建缓存位于 `.cache`。如下载受网络限制，请恢复官方站点访问后重试，不要禁用哈希校验或用来历不明的引擎代替。`npm test` 的真实 OpenList 冒烟测试使用 `OPENLIST_TEST_BINARY` 指向已校验的 `vendor/openlist.exe`；它只测试临时本地盘，不使用真实网盘账号。

## 许可与来源

本项目按 AGPL-3.0-only 分发，完整许可见 `LICENSE`。OpenList 二进制保持原样，许可与版权声明保存在 `vendor/licenses/OpenList-LICENSE.txt`，对应 v4.2.6 源码保存在 `vendor/source/OpenList-v4.2.6.tar.gz`，并随 EXE 放在解包资源中。二进制报告的前端版本同为 v4.2.6，其源码归档和原始许可也一同保存在 `vendor/source` 与 `vendor/licenses`。请将源码包与 EXE 一同交付，并在再次分发或提供修改版本时履行相应许可义务。

- [OpenList v4.2.6 发布](https://github.com/OpenListTeam/OpenList/releases/tag/v4.2.6)
- [OpenList v4.2.6 源码与构建文件](https://github.com/OpenListTeam/OpenList/tree/v4.2.6)
- [普通夸克驱动说明](https://doc.oplist.org/guide/drivers/quark)
- [115 Open 驱动说明](https://doc.oplist.org/guide/drivers/115_open)
- [Electron 44.4.5](https://releases.electronjs.org/release/v44.4.5)

其他运行时组件许可见 `THIRD_PARTY_NOTICES.md`。本项目不是夸克、115、Electron 或 OpenList 官方客户端。
