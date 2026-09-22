# 解码服务（飞牛 NAS / Docker）

把「转码」这件事从手机搬到 NAS 上。手机 APK 里原来内嵌了一套 30MB 的 arm64
ffmpeg + ffprobe，本机转码；现在整套删掉，转码交给这个容器。

```
┌──────────┐   ① 直连拉流（WebDAV，手机本地做）
│  手机 APK │ ────────────────────────────────►┌──────────┐
│  (11MB)  │                                  │  NAS     │
│          │   ② 转码请求 /api/transcode ────►│ WebDAV   │
└──────────┘         │                        └──────────┘
      ▲              ▼                              ▲
      │      ┌──────────────────┐                   │
      │      │  解码服务 (本容器) │ ③ 自己拉 WebDAV ──┘
      └──────│  ffmpeg 边转边吐  │
   ④ mp4 流  └──────────────────┘
```

只有 ② 这一件事走容器。浏览、缩略图、探测时长仍由手机本地完成 —— 那些不需要
ffmpeg，搬过去只会多一次网络往返。

---

## 为什么不用手机自己转（这段历史别删）

改造前 APK 里内嵌了 `android/assets/ffmpeg/{ffmpeg,ffprobe}`（共 30MB，arm64-v8a，
来自 `hzw1199/Android-FFmpeg-Prebuilt` 的 ffmpeg 8.1.1，LGPL 构建）。放弃它是因为：

| 问题 | 实测 |
|---|---|
| 1080p 软编跟不上 | **0.37× 实时** —— 看 1 分钟要等 2 分 40 秒 |
| 硬编不可靠 | `h264_mediacodec` 常「进程活着、退出码 0、一帧不出」，只能靠「等 12 秒看有没有数据」去猜 |
| 发热掉电 | 转一部片手机烫得像暖手宝 |
| 体积 | 30MB，把 APK 从 11MB 撑到 40MB |

NAS 的 CPU 是手机的几倍，而且**插着电常开**。这活本来就该它干。

> ⚠️ 那个构建是 **LGPL**（`--disable-gpl`），**没有 libx264**。所以改造前手机能用的
> H.264 只有 `h264_mediacodec`（硬编）和 `h264_v4l2m2m`（多数设备没有）。
> 容器里用的是全量 ffmpeg，`libx264`、VC-1/WMV 解码器都有 —— 这正是当初内嵌
> 解码存在的唯一理由（ASF/WMV/VC-1 片浏览器和 Media3 都解不了）。

---

## 快速开始

### 1. 传文件到 NAS

把整个 `decode-server/` 目录传到飞牛的某个共享文件夹里（File Station / SMB 都行），
比如 `/vol1/1000/docker/douyin-nas-decode/`。

只需要这几个文件：

```
decode-server/
├── server.js            ← 服务本体（零 npm 依赖，纯 Node http）
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── selftest.js          ← 可选：不开 Docker 也能测
└── data/                ← 运行时会生成（放 config.json）
```

### 2. 改 docker-compose.yml 里的三个环境变量

```yaml
environment:
  DAV_URL:  "http://192.168.1.100:5005"   # ← 你的 WebDAV 地址
  DAV_USER: "boki"                        # ← 你的用户名
  DAV_PASS: "你的密码"                     # ← 必填！默认是空的
```

> ⚠️ **容器里不能用 `127.0.0.1` / `localhost` 当 DAV_URL** —— 那是容器自己的回环地址，
> 指向不了 NAS 上的 WebDAV。必须写 NAS 在局域网里的真实 IP。

### 3. 构建并启动

在飞牛的 SSH 里（或者用飞牛的 Docker Compose 图形界面）：

```bash
cd /vol1/1000/docker/douyin-nas-decode
sudo docker compose up -d --build
```

第一次构建要下载基础镜像 + 装 Node，大概 3~8 分钟（取决于网络）。

### 4. 验证

```bash
# 容器在不在
sudo docker compose ps

# 健康检查（有 ffmpeg 才是 200）
curl -s http://127.0.0.1:8099/api/health

# 能力探测 —— 这是手机那边判「能不能转码」的依据
curl -s http://127.0.0.1:8099/api/caps
```

`/api/caps` 该长这样：

```json
{
  "ok": true,
  "service": "douyin-nas-decode",
  "version": "1.0.0",
  "ffmpeg": true,
  "encoder": "libx264",
  "hardware": false,
  "canTranscode": true,
  "paceRate": 4194304,
  "webdav": true
}
```

**`canTranscode` 必须是 `true`。** 是 `false` 就说明容器里 ffmpeg 没跑起来，看日志：

```bash
sudo docker logs douyin-nas-decode
```

---

## 手机上怎么配

APK 里打开「我的 → 设置」，找到 **解码服务器地址**，填：

```
http://你的NAS的IP:8099
```

点旁边的「测试」。看到「✅ 解码服务可用，编码器 libx264（软件编码）」就成了。

> 留空 = 不做转码，只能播 mp4 / mov / webm。
>
> ⚠️ 测试按钮**不能**拿输入框里的值直接去连 —— 解码服务和手机上的本地服务是
> **不同的源**，浏览器会拿 CORS 挡掉，一个本来通的地址会显示成「连不上」。
> 所以它是先保存地址、再由手机后端代理去连（`GET /api/caps`）。
> 这也是为什么点「测试」会把地址写进配置 —— 这是有意的，不是 bug。

---

## 硬件加速（可选，但强烈建议）

`docker-compose.yml` 里已经注释好了两段，按你的硬件选一段打开。

### Intel 核显 / AMD 核显（QSV / VAAPI）

先确认宿主机有 `/dev/dri`：

```bash
ls -l /dev/dri
# 应该有 card0 / renderD128 之类
```

然后打开 compose 里的：

```yaml
devices:
  - /dev/dri:/dev/dri
```

### NVIDIA 独显（NVENC）

宿主机需要装 `nvidia-container-toolkit`，然后打开：

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

> YAML 里是 `count: all` + `capabilities: [gpu]`，**不是**命令行的 `--gpus all`。

配好之后重启容器，再看一次 `/api/caps` —— `hardware` 应该变成 `true`，
`encoder` 变成 `nvenc` / `qsv` / `vaapi`。

**不挂也能正常工作**，只是走 libx264 软编。飞牛那类机器软编 1080p 一般也够实时。

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/caps` | 能力探测。手机靠 `canTranscode` 判断能不能转 |
| GET | `/api/health` | 健康检查。没 ffmpeg 时返回 503（容器会因此变 unhealthy） |
| GET | `/api/version` | 版本号 |
| GET | `/api/encoders` | 列出探测到的可用编码器 |
| GET | `/api/probe?p=<路径>` | 读时长 / 宽高 / 编码。也接受 `src=<绝对 http 地址>` |
| GET | `/api/transcode?p=<路径>&t=&mode=&h=` | **主接口**：边转边吐 mp4 流 |
| HEAD | `/api/transcode?...` | 同上，但不回响应体（只探活） |

`/api/transcode` 的参数：

- `p` —— 视频相对路径（相对 WebDAV 根），**必填**（或用 `src` 传绝对地址）
- `t` —— 从第几秒开始转（默认 0）。这是唯一的 seek 手段：转码流没有可 seek 区间，
  拖进度条 = 带新 `t` 重开一路
- `mode` —— `auto`（默认，能重封装就重封装）/ `copy`（强制重封装）/ `encode`（强制重编码）
- `h` —— 高度上限，默认 720。1080p 片降到 720 在手机屏上基本看不出差别

响应头：

- `X-Transcode: remux | encode` —— `remux` 是只换封装的直通
- `X-Transcode-Encoder: nvenc | qsv | vaapi | v4l2m2m | libx264`
- `X-Transcode-Start: <秒>` —— 本次流的起点（前端进度条靠它换算）

---

## 调参

在 `docker-compose.yml` 的 `environment` 里放开注释：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8099` | 监听端口 |
| `PACE_RATE` | `4194304`（4MB/s） | 投递限速。局域网好可以调到 `8388608`，Wi-Fi 差降到 `2097152` |
| `PACE_BURST` | `4194304`（4MB） | 起播/快进后先快灌多少字节把缓冲填满 |
| `LOG_LEVEL` | `info` | `info` 或 `quiet` |

### 为什么必须限速（别关掉）

转码速度（实测 2~4MB/s）远快于播放速度（1080p 约 1MB/s）。不限速的后果有两个：

1. 局域网 / Wi-Fi 被撑爆 —— NAS 还要同时发文件给手机，双向挤同一条无线；
2. **一快进就看起来卡死** —— 管道里堵着的「旧位置」数据得先排空才轮到新画面。

所以按略高于播放速率的节奏匀速投递：起播先快灌一小段（`PACE_BURST`）把缓冲填满，
之后按 `PACE_RATE` 限速。

---

## 不开 Docker 也能测

`selftest.js` 直接用 Node 跑服务本体（和容器里走的是同一份代码）：

```bash
# 需要本机有 ffmpeg（放在 ../bin/ 或 PATH 里）
export DAV_URL=http://192.168.1.100:5005
export DAV_USER=boki
export DAV_PASS=你的密码
node decode-server/server.js &

# 用绝对地址测（不需要 WebDAV 配置）
node decode-server/selftest.js http://192.168.1.100:5005/云下载/片子.mp4
```

> 为什么要有这个脚本：Git Bash 下 `curl -o /tmp/x` 有 MSYS 路径翻译问题，
> `-m` 超时还会**丢弃已经收到的数据** —— 字节数完全不可信。
> 这个脚本在 Node 进程里自己读流，数字是准的。
>
> **踩过的坑**：一开始用 curl 测出「只有 28 字节」，排查半天以为是限速写错了，
> 实际是服务端一个 `if (settled) return` 把首块之后的所有数据都丢了
> （`settled` 本意是「这次尝试已有结论」，却被当成数据闸门用）。
> 28 字节正好是 mp4 的 `ftyp` 头。这个 bug 只有靠可信的字节计数才抓得住。

---

## 常见问题

### `/api/caps` 返回 `canTranscode: false`

容器里 ffmpeg 没跑起来。看日志：

```bash
sudo docker logs douyin-nas-decode
```

大概率是基础镜像没拉全（网络问题），或者你为了瘦身把 `jrottenberg/ffmpeg`
换成了 alpine 版。

> ⚠️ **绝不要用 `alpine` + `apk add ffmpeg`**。Alpine 的 ffmpeg 是精简构建，
> 会砍掉解码器 —— 我们**恰恰需要** VC-1 / WMV3 / WMAPRO（这正是内嵌解码当初
> 存在的唯一理由）。另外 musl 也可能让第三方 `.so` 加载失败。
> Dockerfile 里用的是 `jrottenberg/ffmpeg:7.1-ubuntu`（全量，Ubuntu 基底）。

### 转码 200 但前端一直转圈

打开 `/api/caps` 看 `paceRate`。如果响应体只有一千多字节的纯头、没有画面，
说明编码器出了 0 帧 —— 换 `mode=copy` 试试，或看容器日志里 ffmpeg 的 stderr。

### 手机连不上 8099

1. `sudo docker compose ps` 确认容器在跑；
2. `curl http://127.0.0.1:8099/api/caps` 在 NAS 本机能不能通；
3. 飞牛的防火墙 / 路由器有没有拦 8099；
4. 手机和 NAS 是不是同一个局域网（别一个连 2.4G 一个连 5G 隔离了）。

### 拖进度条要等很久

看 `PACE_BURST`。快进后客户端里的旧数据 + 服务端管道里的旧数据都要先排空，
`PACE_BURST` 太大这个排空时间就长。Wi-Fi 差的话把它调小（比如 `2097152`）。

---

## 目录结构

```
decode-server/
├── server.js           服务本体（~34KB，零 npm 依赖）
├── Dockerfile          基于 jrottenberg/ffmpeg:7.1-ubuntu + Node 22
├── docker-compose.yml  端口 8099、WebDAV 环境变量、硬件透传（注释）
├── .dockerignore       排除 ../public ../bin ../android（那些是 APK 侧的，别打进去）
├── selftest.js         不开 Docker 的自测脚本
└── README.md           本文件
```

> ⚠️ `.dockerignore` 里排除了 `../bin` —— 那是 200MB 的 Windows 版 ffmpeg（PC 用的），
> 别打进镜像。镜像里用的是 `jrottenberg/ffmpeg` 自带的 Linux 版。
