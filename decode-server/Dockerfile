# douyin-nas 解码服务
# =====================================================================================
#  基础镜像的选择（这里踩过坑，说明一下为什么不用 alpine）
# =====================================================================================
#  jrottenberg/ffmpeg 是 ffmpeg 社区维护的官方级镜像，按 ffmpeg 版本打 tag，
#  自带**完整的**编解码器集合：libx264 / libx265 / aac / vc1 / wmv3 / wmapro …
#
#  ⚠️ 千万不要用 `alpine` + `apk add ffmpeg`：
#     Alpine 的 ffmpeg 包为了控制体积裁掉了不少解码器，
#     而且 musl libc 下某些第三方 .so 会有兼容问题。
#     我们正是要拿它解 VC-1/WMV/ASF 这些冷门老片（原先内嵌 ffmpeg 就是为了这个），
#     裁过的构建可能恰好缺我们最需要的那几个解码器 —— 那就白折腾了。
#
#  想要更小的镜像可以用 `jrottenberg/ffmpeg:6.1-alpine`，但**务必先跑
#  `docker compose exec decode ffmpeg -decoders | grep -E 'vc1|wmv3|wmapro'`
#  确认解码器还在**。本项目默认用 debian 版，稳。
# =====================================================================================

FROM jrottenberg/ffmpeg:7.1-ubuntu

# 容器里跑的是普通 Node 脚本，不需要任何 npm 依赖（零依赖），
# 所以直接用发行版自带的 nodejs 就够 —— 但 ubuntu 版的 node 往往太老，
# 这里从 NodeSource 装一个 LTS。
# ⚠️ jrottenberg/ffmpeg 的 ubuntu 基础镜像是 ubuntu:22.04，
#    用 NodeSource 的 setup_22.x 脚本即可；不用 24.x 是为了省事（22 是当前 LTS）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get purge -y gnupg \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 只拷服务端脚本 —— 这个容器**不需要**前端、不需要 public/、不需要 bin/
COPY server.js /app/server.js

# 可选：挂一个卷放 config.json（WebDAV 地址），也可以只用环境变量
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=8099 \
    LOG_LEVEL=info

EXPOSE 8099

# 健康检查打 /api/health：它会在 ffmpeg 缺失时返回 503，
# 于是容器会被标成 unhealthy —— 这比「起来了但转不了码」早暴露得多。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8099)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "/app/server.js"]
