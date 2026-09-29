# 夸克与 115 互传工具：需求访谈记录

状态：首版项目与 Windows x64 单文件 EXE 已生成；本地自动化和实际 EXE 启动检查通过，真实网盘账号联调尚未进行。详见 validation.md。

## 目标

参考用户提供的《OpenList_夸克转115_Windows图文教程.pdf》，创建可构建为 Windows EXE 的项目，双击后通过图形界面完成网盘文件复制。教程用于了解操作流程，不代表用户授权执行其中的账号修改、授权撤销或删除操作。

## 用户已确认

1. 首版支持夸克与 115 双向复制，保留源文件。
2. 接受本机中转；传输时电脑保持开机联网。
3. 缓存目录可以选择；传输完成后自动清理本次任务的临时文件。
4. 登录优先扫码或网页登录，并保存登录状态；自动接入不可用时允许手动填写凭证。
5. 独立中文桌面窗口：左侧夸克、右侧 115，选择文件后点击方向按钮复制，下方显示任务进度。
6. 保存任务清单和完成记录。程序重启或网络恢复后，只重试未完成文件；允许单个中断文件从头传输，不要求字节级续传。
7. 同名文件保留两份，新文件自动加序号；依靠本次任务记录识别已完成文件。
8. 首版按整文件夹、几十到几百 GB 的典型任务设计，包含子目录、逐文件排队、磁盘空间检查。
9. 复制完成后核对目录结构、文件数量和精确字节大小，列出失败项；不宣称已完成逐字节内容校验。
10. 同名文件夹合并目录结构，内部同名文件仍自动加序号保留两份。
11. 增加退出当前账号：清理所选网盘在本软件内的连接凭证与网页登录状态，保留云端文件及另一侧账号。未完成任务须先完成或取消；退出后已取消旧任务保留记录但不再重试。

## 教程提供的技术背景

- 教程路线是普通 Quark 驱动与 115 Open 驱动，文档依据 OpenList v4.2.6。
- 夸克使用 Cookie，115 Open 使用 Access Token 和 Refresh Token。
- 夸克到 115 可能需要下载整个文件，计算校验值后尝试秒传；不能承诺免下载或固定速度。
- 目录任务创建成功不能直接等同于全部文件复制完成。
- 恢复任务列表不等同于文件字节级断点续传。
- 教程没有使用真实账号执行端到端测试；项目仍需要在真实账号上分别验证两个方向。

## 实现默认值

- Windows 10/11 x64，独立窗口、中文界面，便携单 EXE 分发，内置引擎。
- 交付完整项目源码与构建脚本，运行时自动建立配置、任务与缓存目录。
- 单文件顺序处理；不提供源文件删除或覆盖目标文件功能。
- 按完整缓存及上传暂存的实际空间需求检查磁盘，不承诺仅占一份文件空间。
- 程序重新打开后保留未完成队列，由用户点击继续。
- 仅连接本机回环地址；凭证不写入界面日志。

## 实现前待验证

- 两个驱动在所选版本下是否均能读取原文件并上传。
- 扫码或网页登录能否可靠接入；若不支持，如何反馈给用户。
- 引擎集成方式、任务状态及持久化边界。

本文只记录已经确认的产品需求与待验证事项，不把推荐选项视为用户已经接受。

## 官方源码初步核查（仍需实测）

- 普通夸克驱动 `Put` 有上传实现，115 Open 的 `Link` 有下载实现，双向复制具备实现基础。
- 夸克对象未提供上传所需哈希；115 Open 缺 SHA1 时完整缓存并计算哈希。反方向夸克上传需要 MD5 与 SHA1，115 对象只提供 SHA1 时也需要缓存计算。两个方向均不承诺免下载。
- 核查来源：
  - https://github.com/OpenListTeam/OpenList/blob/main/drivers/quark_uc/driver.go
  - https://github.com/OpenListTeam/OpenList/blob/main/drivers/quark_uc/types.go
  - https://github.com/OpenListTeam/OpenList/blob/main/drivers/115_open/driver.go
  - https://github.com/OpenListTeam/OpenList/blob/main/drivers/115_open/types.go
- 普通夸克文档仍采用 Cookie 接入，并提示历史逆向接口的维护限制；夸克 TV 虽支持扫码，但只支持访问和下载，不能直接替代普通夸克实现双向传输。
- OpenList 提供跨盘复制与任务管理接口；任务持久化需要显式配置，且不等于单文件字节级断点续传。
- OpenList 采用 AGPL v3；内置分发时须处理许可、版权声明及对应源码交付。未决定闭源分发方案。
- 相关官方资料：
  - https://doc.oplist.org/guide/drivers/quark
  - https://doc.oplist.org/guide/drivers/115_open
  - https://github.com/OpenListTeam/OpenList/blob/main/internal/fs/copy_move.go
  - https://github.com/OpenListTeam/OpenList/blob/main/server/router.go
  - https://doc.oplist.org/configuration/configuration
  - https://github.com/OpenListTeam/OpenList/blob/main/LICENSE
