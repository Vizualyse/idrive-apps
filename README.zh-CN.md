# Vizualyse iDrive 应用简体中文版

**Translation by：抖音 小白科技杂物社 · BiliBili 小白151 · GitHub [JackieZ123430](https://github.com/JackieZ123430)**

[English](README.md) · [原项目](https://github.com/Vizualyse/idrive-apps) · [中文源码](https://github.com/JackieZ123430/vizualyse-idrive-apps-cn) · [汉化来源与许可证](NOTICE.zh-CN.md)

适用于 BMW MGU / iDrive 7。本仓库包含 5 个应用及对应后台组件。每个应用负责车机菜单和控制，后台组件负责实际投射、浏览或运行游戏，安装时需要同时满足依赖。

| 应用 | 用途 | 中文覆盖 |
|---|---|---|
| 仪表投射 Cast | 将手机提供的串流地址输出到仪表、HUD 或中控屏；配合 hook111 显示 CarPlay 第二屏地图 | 车机列表、触控页、手机控制页、状态和提示 |
| 浏览器 Browser | 在中控屏打开 Chromium，通过手机输入网址与文字 | 车机列表、触控页、手机控制页、内存和图形设置 |
| 仪表主题 Cluster themes | 预览和选择仪表主题，按驾驶模式切换 Sport / Comfort 外观 | 车机列表、主题选择器、设置和提示；主题画面内的品牌及固定英文标记保留 |
| Moonlight 串流 | 连接运行 Sunshine 的电脑，将游戏画面和声音串流至车机 | 车机列表、触控页、手机配对和控制页、状态和提示 |
| 车载 Steam | 在车机运行受支持的 Windows 游戏，管理安装、内存与画面选项 | 车机列表、触控页、手机控制页、性能和安装设置 |

外部网页、游戏本体、Steam 提供的游戏名称和第三方程序原始日志不属于本仓库界面翻译范围。原有停车限制和车辆控制逻辑沿用上游实现。

## 安装到车机

在 MGU Store 添加中文源 **`JackieZ123430/MGU-CN-XIAOBAI`**，选择相应中文应用。后台组件及其依赖由商店处理。应用与后台组件必须使用配套版本，单独安装菜单应用不能提供完整功能。

同名应用沿用原应用 ID 和数据目录。首次使用中文版本前请记录现有版本；不要让原源和中文源交替覆盖同一个应用。手机控制页地址含访问令牌，请从车机二维码打开自己的连接。

- Cast：[原应用说明](apps/vizualyse_cast/README.md)。CarPlay 第二屏另需满足 hook111 的要求。
- Browser：[原应用说明](apps/vizualyse_chromium/README.md)。GPU / 游戏模式的实验性质和自动回退行为保留。
- Cluster themes：[原应用说明](apps/vizualyse_cluster/README.md)。预览、试用和原车警告覆盖关系请先阅读。
- Moonlight：[原应用说明](apps/vizualyse_moonlight/README.md)。电脑需要 Sunshine，并与车机处于可互通的网络。
- Steam：[原应用说明](apps/vizualyse_steam/README.md)。游戏兼容性、磁盘占用和性能以具体游戏及车机条件为准。

## 构建中文版本

英文源码保留。汉化工具只创建独立的中文源码目录，输入仓库不会被改写：

```sh
python localization/prepare.py --out ../idrive-apps-zh-CN
cd ../idrive-apps-zh-CN
node apps/vizualyse_cast/tools/build.js
node apps/vizualyse_chromium/tools/build.js
node apps/vizualyse_cluster/tools/build.js
node apps/vizualyse_moonlight/tools/build.js
node apps/vizualyse_steam/tools/build.js
```

生成的 `.src.tgz` 由车机使用自己的 SDK 链接。构建完整后台组件需要上游文档列出的 Linux / Docker 环境及二进制依赖。源码包不包含 BMW SDK。

`localization/zh-CN.tsv` 是词表。翻译只发生在界面输出位置：车机文字写入、触控绘制和手机页面文本。命令、应用 ID、设置值和连接地址保留原值。运行时日志沿用上游，方便排查。

修改词表后，如引入新的汉字，需要重新生成字库。安装 Pillow，从 [Google Fonts 的 Noto Sans SC 目录](https://github.com/google/fonts/tree/main/ofl/notosanssc) 获取字体及许可证，再运行：

```sh
python localization/build_fonts.py --font NotoSansSC.ttf --license OFL.txt
```

检查与预览：

```sh
python localization/test_localization.py
```

电脑端检查不能代替实车验证。构建结果和交付说明会分别记录已完成的检查、尚未验证的部分及所用上游版本。

## 署名和许可证

原项目代码及相关组件保留各自许可证；中文翻译和构建工具使用 GPL-3.0-or-later。中文版本包含“小白科技杂物社 / 小白151 / JackieZ123430”署名。详情见 [NOTICE.zh-CN.md](NOTICE.zh-CN.md) 和根目录 [LICENSE](LICENSE)。
