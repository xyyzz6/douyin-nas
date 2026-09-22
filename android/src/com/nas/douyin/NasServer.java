package com.nas.douyin;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 内嵌在 APK 里的本地 HTTP 服务（监听 127.0.0.1）。
 *
 * 作用：把「原来跑在电脑上的 Node 后端」搬到手机里，让 WebView 像访问本地网站一样工作，
 * 前端 public/ 的 HTML/JS 几乎零改动。接口协议与 server.js 的 handleApi 1:1 对齐。
 *
 * 网络层用 java.net.ServerSocket 手写，避免依赖 JDK 专有的 com.sun.net.httpserver
 * （那个类 Android 运行时根本没有，会导致 NoClassDefFoundError 闪退）。
 */
public final class NasServer {

    private static final String TAG = "NasServer";
    private static final String PREFS = "nasdy";

    private ServerSocket server;
    private Thread acceptThread;
    private volatile boolean running = false;
    private final Context ctx;

    // 当前生效的 WebDAV 配置（字段与 server.js 的 config.json 对齐）
    private String baseUrl = "";
    private String user = "";
    private String pass = "";
    private String dir = "";
    private List<String> dirs = new ArrayList<>();
    /* 🔒 「不重扫」的片源文件夹（2026-09-18 加）。
     *    用户的原话：「有些文件夹我添加上去之后，不会再新增文件了，每次都扫描的话太浪费时间了」。
     *    扫一遍大目录要十几分钟（§42 实测 802 秒），把「已经不会再变」的文件夹标上，
     *    常规扫描就**整个跳过它**，直接用上一份片库里属于它的视频。
     *    ⚠️ 只在「上一份片库里确实有它的视频」时才跳过 —— 一次都没扫过就必须照扫一次，
     *    否则用户标完发现这个文件夹一条都没有，只会以为坏了。 */
    private List<String> skipDirs = new ArrayList<>();
    private boolean recursive = true;
    /* 扫描深度：**0 = 不限**。
       ⚠️ 原来是 4。2026-09-18 实测 /dav/示例片源 有 48.4% 的视频在第 5 层（5095 个），
          深度 4 会把它们**全部**漏掉而且不报错 —— 就是用户说的「藏得深扫不出来」。 */
    private int maxDepth = 0;
    // ⚠️ 这里原来有 `playableOnly`（设置页「只列出能直接播的格式」开关）。
    //    2026-09-19 起片库**列出 NasService.ALL_EXTS 全部格式**（能播与否由 playable 标）。
    //    旧 SharedPreferences 里残留的那一项没人读，下次 saveConfig 自然覆盖掉。
    private String fit = "contain";
    private String nickname = "NAS 影迷";

    /* =================================================================================
     * strm 自动库配置（2026-09-20）。
     *
     * 🔴 **2026-09-20 晚 二次改版（用户拍板「A 回传不要了，B 完全开放」）**：
     *
     *   A. **砍掉 NAS 回传**。原来有两条输出路（strmOut 传回 NAS + strmLocal 存手机），
     *      现在**只存手机**，且落点固定为 `getExternalFilesDir()/strm`（见 strmLocalDir()）。
     *      用户**不再需要填写任何路径**，也**不再需要「所有文件访问」权限** ——
     *      getExternalFilesDir 是 App 自己的目录，写上就通，免授权。
     *      ⚠️ 别再让 strmOut 复活：它是 Emby/Jellyfin 那套「在 NAS 上建库」的思路，
     *        用户已经明确不要了。字段、读写链路、PUT/MKCOL、300ms 节流**全部删干净**。
     *      ⚠️ 免授权的代价：这个目录在 Android/data/ 下，部分文件管理器看不见；
     *        但它在 **App 自己的**外部目录里，卸载才会清，且不必申请 MANAGE_EXTERNAL_STORAGE。
     *
     *   B. **监控项与片源彻底解耦**。原来 `strmJobs` 被强校验成「dirs 的子集」，
     *      于是想监控一个没加进片源（或 CD2 根目录下任意一个）的文件夹是**做不到**的。
     *      现在 strmJobs 是**独立清单**：任意 WebDAV 目录都行，可多选。
     *      ⚠️ 代价：删片源不会再顺手清监控项（两套清单各管各的），这是有意的。
     *
     * 是什么：对监控清单里的目录定期做一轮 PROPFIND，把每个视频的 WebDAV 路径
     * 写成 `<固定目录>/<监控目录名>/<目录内相对路径>.strm`。挂到 Emby/Jellyfin
     * 这类媒体服务器后，它们读 strm 拿到的是**文件路径**而不是一次全库扫描 ——
     * 风控压力从「媒体服务器天天列 115」变成「本 App 按设定间隔列一次」。
     *
     * 增量：filesDir/strm_manifest.json 记「视频路径 → strm 落点」，落点没变就
     * 跳过重写（strm 内容由路径决定，路径没变内容就不会变）。
     * ================================================================================= */
    /** 🔴 监控目录清单 —— **不是** dirs 的子集（2026-09-20 起解耦，见上面 B 段） */
    private List<String> strmJobs = new ArrayList<>();
    private int strmIntervalH = 0;        // 自动扫描间隔（小时）；0 = 仅手动
    /* 体积阈值（MB，2026-09-22 用户要求「可以自定义生成的文件大小，小于设定大小跳过生成」）。
     * 判据是**源视频的体积**（PROPFIND 的 getcontentlength），不是 .strm 文件本身的大小 ——
     * 后者只有几十字节，拿它比会全军覆没（「屏蔽小文件」踩过这个坑，见 isStrmPointer）。
     * 0 = 不限制（全部生成，与加这个功能之前完全一致）。 */
    private int strmMinSizeMB = 0;

    /* ============ strm 备份 / 还原（2026-09-20，用户要素「方便备份和换机」）============
     * 导出 = 把本机 strm 库打包成 zip；导入 = 解回本机 + 合并索引 + 补监控清单。
     * 四个决策点（用户全选推荐项）：落到手机「下载」目录 / 完整备份 / 系统文件选择器导入 /
     * 冲突按「合并补缺」（已存在的跳过）。
     *
     * 🔴 为什么这套逻辑在**服务端**而不是前端：
     *   1. 它要读写 strmLocalDir() 与 manifest —— 只有服务端知道它们在哪；
     *   2. 暴露成 HTTP 接口后，**不用碰系统文件选择器就能整套验证**
     *      （adb forward + curl：导出 → 删文件 → 导入 → 校验）；
     *   3. 网页版将来要复用同一对接口。
     *
     * 包结构（zip 内）：
     *   backup.json   元信息：格式版本 / 导出时间 / 版本号 / 监控清单 / 扫描间隔
     *   manifest.json 增量索引（视频路径 → strm 落点）—— 带上它换机后**不用重扫**
     *   strm/**       .strm 文件，路径相对 strm 根目录
     *
     * ⚠️ 换机为什么原样能用：`.strm` 内容里的 `local:/` 前缀是**相对 strm 根**的
     *    （见 LOCAL_PREFIX），文件搬过去就行，不需要改任何路径。
     * ⚠️ 导入必须防 **zip slip**（`../../xx` 逃出 strm 目录）→ 见 safeChild()。 */
    private static final int STRM_BK_FORMAT = 1;
    private static final String STRM_BK_META = "backup.json";
    private static final String STRM_BK_MANIFEST = "manifest.json";
    private static final String STRM_BK_PREFIX = "strm/";

    /* ---- strm 任务运行状态（GET /api/strmjob 回报；跨请求共享所以都是 volatile） ---- */
    /** 防重入：手动触发 + 定时触发（甚至连点两下按钮）可能撞车，CAS 抢不到就跳过本轮 */
    private final java.util.concurrent.atomic.AtomicBoolean strmRunning =
            new java.util.concurrent.atomic.AtomicBoolean(false);
    private volatile int strmDone = 0, strmTotal = 0, strmAdded = 0, strmSkipped = 0, strmFailed = 0;
    /** 因为「小于体积阈值」被跳过的条数（2026-09-22）。与 strmSkipped（增量命中）分开计。 */
    private volatile int strmTooSmall = 0;
    private volatile String strmLastError = "";
    /** 最近一轮完成时间。落 SharedPreferences（strmTouchLastRun），供冷启动过期补偿判断 */
    private volatile long strmLastRun = 0;
    /**
     * strm 库的**内容版本**：真的写了 .strm、或按体积阈值删掉了旧条目，就 +1。
     *
     * 🔴 2026-09-22 加。起因：用户报「手机新生成的 strm 不会自动备份到服务器」。
     *    真因是**上传那一侧压根没有自动触发点**（只绑在设置页那个按钮上），
     *    这个计数器的作用是给前端一个**精确的**「库变过没有」判断依据，
     *    让「生成完就自动传一份备份」这件事有据可依。
     *
     * ⚠️ 为什么不用 lastRunAt 判断：一轮跑完时间戳一定会变，**即使一个文件都没动**
     *    （全增量命中），拿它当信号会导致每轮都白传一遍几 MB 的备份。
     *    也不能只看 added：按阈值**删除**时 added 是 0，但库确实变了。
     *    所以只在实际改动落盘的两处 +1。
     *
     * 必须落盘（同 strmLastRun）：App 重启后归 0 的话，前端存的旧值对不上，
     * 会误判成「变过了」白传一次。
     */
    private volatile long strmRev = 0;
    /** 单线程调度器：定时扫 strm。interval 变更时 cancel 旧任务重排（strmTimer） */
    private final java.util.concurrent.ScheduledExecutorService strmSched =
            java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "strm-sched");
                t.setDaemon(true);
                return t;
            });
    private java.util.concurrent.ScheduledFuture<?> strmTimer;

    /**
     * 刚刚「因为 strm 生成完成而自动加了本机片源」（2026-09-20）。
     *
     * 用途：片源多了一条，**片库必须重扫**才刷得到那些 .strm —— 而这次改动
     * 是后端自己发起的（用户没点任何按钮），前端那条「配置变了就重扫」的路径
     * 根本不会触发。所以由 /api/strmjob 的状态回报这个标记，前端看到就静默
     * 拉一次片库。
     *
     * ⚠️ 一次性：读取即清除（见 handleStrmJob），否则前端每次拉状态都会重拉片库。
     */
    private final java.util.concurrent.atomic.AtomicBoolean localSrcJustAdded =
            new java.util.concurrent.atomic.AtomicBoolean(false);

    /*
     * =====================================================================================
     *  已删除：decodeUrl 字段（2026-09-18 Phase L 回退）
     * =====================================================================================
     *  这里原来是 `private String decodeUrl = "";` —— NAS 上那个 Docker 解码服务的地址。
     *  连同它的健康探测（remoteCanDecode / remoteProbeAt / REMOTE_TTL_MS）、
     *  配置读写（loadConfig / persistConfig / POST /api/config）、
     *  /api/caps 路由、probeViaRemote、RemoteStream 一起删掉了。
     *
     *  ## 那段历史（有用，别删）
     *
     *  最早 APK **内嵌**了一套 arm64 的 ffmpeg + ffprobe（共 30MB），在手机本地转码。
     *  实测这条路问题太多，所以才想把它搬走：
     *    · 1080p 软编在手机上只有 0.37× 实时 —— 看完一集要等一倍多时间；
     *    · 唯一现实的选择 h264_mediacodec 硬编，在部分设备/模拟器转译层上
     *      **进程活着却一帧不出**，还得靠「等 12 秒看有没有数据」来猜；
     *    · 手机转码 = 烫 + 掉电快，本来是来看片的，结果变成了烤机；
     *    · 30MB 二进制让 APK 一直下不来。
     *
     *  于是有了 decode-server/：一个跑在飞牛 NAS 上的 Docker 容器，APK 只负责转发。
     *  它确实是有效的 —— 但代价是**用户必须额外部署并长期维护一个容器**，
     *  还要在设置页填地址、指望 NAS 一直在线。对「装上就能用」的单机场景，这是负担。
     *  **用户 2026-09-18 明确要求整体回退，于是就这样定了。**
     *
     *  ## 回退后是什么样（当前状态）
     *
     *    · APK 自包含，8MB 出头，不依赖任何外部服务；
     *    · /api/transcode 不做转码，只把原文件直通并打 `X-Seekable: 1`；
     *    · seek 靠**原生** HTTP Range（handleStream 支持），前端改 `video.currentTime` 即可；
     *    · 代价：wmv / avi 这类 WebView 解不了的容器回归「不能播」——
     *      探测阶段就会返回「读不出时长」，前端如实标灰，不会点进去卡住。
     *
     *  ## 为什么不要「偷偷加回本地转码」
     *    那条路我们试过并放弃了（见上）。留个半吊子的本地兜底只会让用户以为能播、
     *    结果卡死，比一开始就说不支持更糟。要重开这条路线，请当成一个新决策来做。
     *
     *  decode-server/ 目录**保留在仓库里**做参考（它本身是能用的），
     *  但 APK 的代码不再引用它 —— 这就是为什么这里一个字段都没有。
     */

    private DavClient dav;

    /** 缩略图抽帧 + 落盘缓存（独立目录，不随 App 启动重做） */
    private Thumbs thumbs;

    /**
     * ⚠️ 这台设备上**没有任何转码能力，而且这是有意为之**（2026-09-18 Phase L）
     *
     *  这里原来有个 `private final Ffmpeg ffmpeg` 字段 + 后台置备线程，负责把
     *  assets/ffmpeg/{ffmpeg,ffprobe}（共 30MB）拷到 filesDir 再**本地**转码。
     *  整套已删除 —— 那 30MB 是 APK 瘦不下去的元凶，删掉才从 40MB 回到 8MB。
     *
     *  中间还短暂走过一段「转发给 NAS 上的 Docker 解码服务」（decode-server/），
     *  2026-09-18 也按用户要求整体回退了：那套要用户额外部署并维护一个容器，
     *  对「装上就能用」的单机场景是纯负担。decode-server/ 目录留着做参考，
     *  但 APK **不依赖它、也不再提它**。
     *
     *  于是现在：/api/transcode 只是把原文件直通出去并打上 X-Seekable: 1
     *  （见 handleTranscode 的注释 —— 那才是 seek 逻辑的真正依据）；
     *  /api/probe 只走 MediaMetadataRetriever，探不到的片子就如实报「读不出时长」。
     */

    /**
     * 时长探测结果缓存：相对路径 → 时长/画面尺寸。
     * 探一次要真的读一段远端文件（走 MediaMetadataRetriever 解首帧/metadata），很贵；
     * 前端每次拖进度条、每次渲染卡片都可能问，必须缓存。
     * 用 ConcurrentHashMap 因为多个请求线程会同时查。
     *
     * ⚠️ 为什么缓存里要一起存**画面尺寸**（历史原因，别当成冗余删掉）：
     *    原来是 `Map<String, Double>` 只存时长。后来前端要把**加载转圈对准视频画面矩形**
     *    （`.vbox`，见 app.js 的 fitVideoBox），而当时流是转码出来的 fragmented MP4
     *    （`frag_keyframe+empty_moov`），moov 是空的、分辨率写在 moof 里，
     *    WebView 能解码但**永不回填 `video.videoWidth`**。
     *    现在转码回退了、直连流的 videoWidth 是正常的，但前端那条「按 probe 尺寸摆转圈」
     *    的逻辑还在跑、也仍然需要这两个字段 —— 所以照旧一起缓存，别省。
     */
    private final Map<String, Probe> probeCache = new java.util.concurrent.ConcurrentHashMap<>();

    /** 一次探测的结果：时长（秒）+ 画面像素宽高（拿不到就是 0）。 */
    private static final class Probe {
        final double dur; final int w; final int h;
        Probe(double dur, int w, int h) { this.dur = dur; this.w = w; this.h = h; }
    }

    /** 本机服务端口：缩略图抽帧要拼 127.0.0.1:<port>/api/stream 给自己取流 */
    private volatile int port = 8099;

    /**
     * 正在预热中的视频路径（/api/warm 用），防同一个片重复开线程。
     * ConcurrentHashMap.newKeySet() = 线程安全的 Set。
     */
    private final java.util.Set<String> warmInFlight = java.util.concurrent.ConcurrentHashMap.newKeySet();

    /**
     * .strm 内容缓存（WebDAV 绝对路径 → 解析出的目标，见 resolveStrm）。
     *
     * 为什么必须有它：strm 文件本身只有几十字节，但每次播放都去上游 GET 一遍，
     * 等于给 115 白打一次 API —— 用户加 strm 功能正是为了**少**打 115（防风控），
     * 解析层自己反而高频去读就本末倒置了。进程内缓存住：一个 strm 整个
     * App 生命周期只读一次；片源重扫（目录结构可能变了）时整体清空。
     */
    private final java.util.concurrent.ConcurrentHashMap<String, String> strmCache =
            new java.util.concurrent.ConcurrentHashMap<>();

    /* =====================================================================================
     * 「本机片源」（2026-09-20 用户拍板「选 A」）
     * =====================================================================================
     * 问题：strm 生成在手机本地（strmLocalDir()），但片库扫描**只认 WebDAV**
     *      （doScan 的根全是 `/dav/...`，走 PROPFIND）。于是文件生成了、
     *      handleStream 里解析 strm 的逻辑也早就写好了，**中间却没有任何一条路
     *      能让片库发现它** —— 用户「生成完不知道怎么播」的真身。
     *
     * 解法：给 dirs 引入**一种新形态的片源路径**，用一个前缀把「本机目录」和
     *      「WebDAV 路径」区分开：
     *        · `/dav/115open/云下载`        → WebDAV（原样，走 PROPFIND）
     *        · `local:/strm`               → 本机目录（走 java.io.File 枚举）
     *
     * ⚠️ 为什么用前缀而不是「塞一个绝对路径当片源」：
     *    1. 本机绝对路径（/storage/emulated/0/Android/...）在形状上和 WebDAV 路径
     *       **完全一样**（都以 `/` 开头），任何一处判据都会误判成 WebDAV 送去 PROPFIND，
     *       必然 404 —— 那就成了一个「看着加了、永远扫不出东西」的哑片源。
     *    2. 前缀让「这是本机」变成一个**可判定的类型**，而不是靠猜。
     *    3. 片源栏能照着前缀显示成「本机」而不是一串长路径（用户要求「一眼看出是本机的」）。
     *
     * ⚠️ 前缀故意选 `local:` —— 它不含 `/`，所以**永远不会与 WebDAV 路径撞车**
     *    （WebDAV 路径经 normAbs 后必以 `/` 开头）。判据是 startsWith，不是 equals，
     *    因为将来可能不止一个本机目录。
     *
     * ⚠️ 前缀之后的路径是「相对 strmLocalDir() 的」：`local:/` = strm 目录本身。
     *    这样**换机、换路径都不会失效**（strmLocalDir 会随设备变），
     *    也避免把设备相关的绝对路径写进配置、同步到别处就废了。
     */
    static final String LOCAL_PREFIX = "local:";

    /** 是不是「本机片源」路径（local: 开头）
     *
     * 🔴 2026-09-21：**要容忍前导斜杠**。历史配置里可能存着 `/local:/` 这种脏值 ——
     *    那是老版本把 `local:/` 送进 `normAbs` 补出来的（`POST /api/config` 的 dir
     *    分支就这么写的）。脏值一旦存进去，`startsWith("local:")` 判不出来，
     *    `effectiveDir()` 的短路失效 → 又被补成 `/dav/local:` 这个**不存在的 WebDAV 路径**，
     *    症状是「进文件夹页先弹一句『之前设的文件夹已经打不开了』」。
     *    所以判据统一放宽：先剥掉前导斜杠再比前缀。
     *    ⚠️ 归一用 `normSrc()`（它会把脏值修回 `local:`），别只在这里判一下就算了。 */
    static boolean isLocalSrc(String p) {
        if (p == null) return false;
        String t = p.trim();
        int i = 0;
        while (i < t.length() && t.charAt(i) == '/') i++;
        return t.startsWith(LOCAL_PREFIX, i);
    }

    /**
     * 片源路径归一 —— **两种形态分开走**。
     *
     * 🔴 别拿 `NasService.normAbs` 直接处理本机片源：`local:/strm` 会被它当成
     *    相对路径补成 `/local:/strm`，前缀就此失效，那个片源立刻变成
     *    「形状像 WebDAV、送去 PROPFIND 必然 404」的哑片源。
     *    所有「读进来 / 存下去」片源的地方都必须过这个函数。
     *
     * 🔴 开头先**剥掉前导斜杠**：那是在修历史脏值（`/local:/` → `local:/`），
     *    见 isLocalSrc 的注释。WebDAV 路径剥完再交给 normAbs，会重新补回一个 `/`。
     */
    static String normSrc(String s) {
        String t = (s == null ? "" : s).trim();
        while (t.startsWith("/")) t = t.substring(1);
        if (t.isEmpty()) return "";
        if (t.startsWith(LOCAL_PREFIX)) {
            return LOCAL_PREFIX + NasService.normAbs(t.substring(LOCAL_PREFIX.length()));
        }
        return NasService.normAbs(t);
    }

    /**
     * 本机片源路径 → 磁盘绝对路径。非本机路径返回 null。
     *
     * `local:/` → `<strmLocalDir>`；`local:/云下载` → `<strmLocalDir>/云下载`
     *
     * 🔴 必须防目录穿越：`local:/../../etc` 这类不能逃出 strm 根
     *    （前缀里带 .. 会被 NasService.normAbs 消掉，但**要在归一之后**再拼，
     *     否则 `strmRoot + "/../../x"` 的字符串拼接会直接把 .. 带过去）。
     */
    private String localAbs(String src) {
        if (!isLocalSrc(src)) return null;
        String rel = NasService.normAbs(src.substring(LOCAL_PREFIX.length()));
        java.io.File root = new java.io.File(strmLocalDir());
        java.io.File f = new java.io.File(root, rel);
        try {
            if (!f.getCanonicalPath().startsWith(root.getCanonicalPath())) return null;
        } catch (Exception e) { return null; }
        return f.getAbsolutePath();
    }

    public NasServer(Context ctx) {
        this.ctx = ctx;
        this.thumbs = new Thumbs(ctx);
        // 内嵌 ffmpeg 已移除 —— 不再有 30MB 抄写，构造函数可以立刻返回。
        // （原来这里要 ensureFfmpeg() 起个后台线程去拷贝，现在完全不需要了。）
    }


    /** 从 SharedPreferences 读配置，刷新 DavClient */
    /** 深度夹到 [0, MAX_DEPTH_CAP]。**0 = 不限深度**。 */
    private static int clampDepth(int v) {
        return Math.max(0, Math.min(NasService.MAX_DEPTH_CAP, v));
    }

    public void loadConfig() {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        baseUrl = p.getString("url", "").trim();
        user = p.getString("user", "");
        pass = p.getString("pass", "");
        /* 🔴 必须过 normSrc：历史配置里可能存着 `/local:/` 这种脏值
           （老版本把 local: 送进 normAbs 补出来的）。不过一遍的话它会一直脏下去，
           effectiveDir() 的短路永远失效 → 每进一次文件夹页就弹一次假提示。 */
        dir = normSrc(p.getString("dir", ""));
        String dirsRaw = p.getString("dirs", "");
        dirs = new ArrayList<>();
        if (!dirsRaw.isEmpty()) {
            for (String d : dirsRaw.split("\u0001")) {   // 用 \u0001 分隔，避免路径里的逗号冲突
                if (!d.trim().isEmpty()) dirs.add(normSrc(d));
            }
        }
        /* 老配置没有 skipDirs 这个键，getString 会给 ""，下面自然得到空表。
           顺带把「已经不在 dirs 里」的残留项清掉 —— 文件夹都删了还记着它，
           只会让人看不懂为什么扫描结果里少了东西。 */
        String skipRaw = p.getString("skipDirs", "");
        skipDirs = new ArrayList<>();
        if (!skipRaw.isEmpty()) {
            for (String d : skipRaw.split("\u0001")) {
                if (d.trim().isEmpty()) continue;
                String n = normSrc(d);
                if (dirs.contains(n) && !skipDirs.contains(n)) skipDirs.add(n);
            }
        }
        recursive = p.getBoolean("recursive", true);
        maxDepth = clampDepth(p.getInt("maxDepth", 0));
        fit = p.getString("fit", "contain");
        nickname = p.getString("nickname", "NAS 影迷");
        /* strm 自动库（2026-09-20）。
         * 🔴 监控清单现在**是独立清单**，不再按「仍是片源子集」收敛（见字段头上 B 段）。
         *    只做「归一 + 去重 + 丢掉空串」—— 别再让 `dirs.contains(n)` 回来，
         *    那正是「CD2 根目录下任意文件夹选不了」的病根。 */
        String sjRaw = p.getString("strmJobs", "");
        strmJobs = new ArrayList<>();
        if (!sjRaw.isEmpty()) {
            for (String d : sjRaw.split("\u0001")) {
                if (d.trim().isEmpty()) continue;
                String n = NasService.normAbs(d);
                if (!strmJobs.contains(n)) strmJobs.add(n);
            }
        }
        strmIntervalH = p.getInt("strmIntervalH", 0);
        strmMinSizeMB = Math.max(0, p.getInt("strmMinSizeMB", 0));   // 体积阈值（2026-09-22）
        strmLastRun = p.getLong("strmLastRun", 0);
        strmRev = p.getLong("strmRev", 0);                           // 库内容版本（2026-09-22）
        rebuildDav();
        // 配置就位后把上次扫好的片库读回来 —— 必须放在 rebuildDav() / dirs 之后，
        // 因为 libSig() 要拿这些字段做签名比对。
        // 这是「重启 App 不再等 10 秒重扫」的关键一步，只在这里读一次。
        if (libCache == null) loadLibraryFromDisk();
    }

    private void rebuildDav() {
        dav = baseUrl.isEmpty() ? null : new DavClient(baseUrl, user, pass);
    }

    public boolean isConfigured() {
        return dav != null;
    }

    // ---------------------------------------------------------------- 配置存取

    /** 把当前配置写回 SharedPreferences（保持与前端/原生界面一致） */
    private void persistConfig() {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        SharedPreferences.Editor e = p.edit();
        e.putString("url", baseUrl);
        e.putString("user", user);
        e.putString("pass", pass);
        e.putString("dir", dir);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < dirs.size(); i++) {
            if (i > 0) sb.append('\u0001');
            sb.append(dirs.get(i));
        }
        e.putString("dirs", sb.toString());
        StringBuilder ssb = new StringBuilder();
        for (int i = 0; i < skipDirs.size(); i++) {
            if (i > 0) ssb.append('\u0001');
            ssb.append(skipDirs.get(i));
        }
        e.putString("skipDirs", ssb.toString());
        e.putBoolean("recursive", recursive);
        e.putInt("maxDepth", maxDepth);
        e.putString("fit", fit);
        e.putString("nickname", nickname);
        // strm 自动库（2026-09-20）。strmLastRun 在任务结束时单独写盘（strmTouchLastRun），
        // 不走这里 —— persistConfig 只在配置变更时调用，把它写进来会让「上次运行时间」失真。
        // 🔴 strmOut / strmLocal 都不再写盘：输出位置固定成 App 内目录（strmLocalDir()），
        //    没有可配的余地。老配置里残留的这两个 key 读的时候也不认（见 loadConfig）。
        StringBuilder sj = new StringBuilder();
        for (int i = 0; i < strmJobs.size(); i++) {
            if (i > 0) sj.append('\u0001');
            sj.append(strmJobs.get(i));
        }
        e.putString("strmJobs", sj.toString());
        e.putInt("strmIntervalH", strmIntervalH);
        e.putInt("strmMinSizeMB", strmMinSizeMB);    // 体积阈值（2026-09-22）
        e.apply();
        // 配置变了签名就变了，盘上那份片库缓存已经不作数 —— 直接清掉，
        // 免得它占着位置、下次启动还白读一遍。
        // （loadLibraryFromDisk 里也会校验签名，这里是提前清理）
        if (!libSig().equals(libCacheSig)) clearLibraryOnDisk();
        rebuildDav();
    }

    /** 从请求 body 里取「临时凭据」：url/user/pass 若传了就覆盖当前配置（与 server.js credOf 一致） */
    private void applyCred(JSONObject body) {
        if (body == null) return;
        if (body.has("url")) {
            String u = body.optString("url", "").trim().replaceAll("/+$", "");
            if (!u.isEmpty()) baseUrl = u;
        }
        if (body.has("user")) user = body.optString("user", "");
        if (body.has("pass")) {
            String pp = body.optString("pass", "");
            if (!pp.isEmpty()) pass = pp;
        }
        rebuildDav();
    }

    // ---------------------------------------------------------------- HTTP 生命周期

    public int start(int port) throws IOException {
        if (running) return port;
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress("127.0.0.1", port));
        this.port = port;
        running = true;
        acceptThread = new Thread(this::acceptLoop, "nas-http");
        acceptThread.setDaemon(true);
        acceptThread.start();
        // strm 定时任务跟着服务一起上（strmSchedule 幂等：先 cancel 旧的再排新的；
        // 这里还顺带做冷启动过期补偿 —— 上次运行超过一个周期就立即补跑一轮）
        strmSchedule();
        Log.i(TAG, "本地服务已启动 :" + port);
        return port;
    }

    public void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (IOException ignore) {}
        server = null;
    }

    private void acceptLoop() {
        while (running) {
            Socket sock = null;
            try {
                sock = server.accept();
            } catch (IOException e) {
                if (!running) return;
                continue;
            }
            final Socket s = sock;
            Thread t = new Thread(() -> handleSocket(s), "nas-req");
            t.setDaemon(true);
            t.start();
        }
    }

    // ---------------------------------------------------------------- HTTP 解析

    private static class Req {
        String method = "GET";
        String path = "/";
        Map<String, String> query = new HashMap<>();
        Map<String, String> headers = new HashMap<>();
        byte[] body = new byte[0];
    }

    private static class Resp {
        int status = 200;
        Map<String, String> headers = new HashMap<>();
        byte[] body = new byte[0];
        InputStream stream = null;
        long streamLen = -1;
    }

    private void handleSocket(Socket sock) {
        try {
            sock.setSoTimeout(60000);
            InputStream in = sock.getInputStream();
            OutputStream out = sock.getOutputStream();

            Req req = readRequest(in);
            if (req == null) { sock.close(); return; }

            Resp resp = route(req);

            StringBuilder head = new StringBuilder();
            head.append("HTTP/1.1 ").append(resp.status).append(' ')
                .append(statusText(resp.status)).append("\r\n");
            for (Map.Entry<String, String> e : resp.headers.entrySet()) {
                head.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            }
            if (resp.stream != null) {
                // 长度未知（上游是 chunked / 没给 Content-Length）时必须用 HTTP/1.1 分块传输。
                // 否则响应只能靠「读到连接关闭」来界定，安卓播放器/WebView 可能直接判失败
                // （群晖 WebDAV 一直带 Content-Length，所以以前没暴露）。
                boolean chunked = resp.streamLen < 0;
                if (chunked) head.append("Transfer-Encoding: chunked\r\n");
                head.append("Connection: close\r\n\r\n");
                out.write(head.toString().getBytes("UTF-8"));
                out.flush();
                /* 🔴 128KB 拷贝缓冲（2026-09-19 提速，原 16KB）：
                 * 刷视频时这条循环是每部片几 GB 的必经之路，16KB 意味着
                 * 每秒成百上千次 read/write 往返，白白烧 CPU 还拉高首帧延迟。
                 * 128KB 一次读满再写，手机上实测明显更跟手。
                 * ⚠️ flush 仍保留在循环里：这是流式代理，不能为了攒大块
                 *    把数据憋在缓冲里 —— 客户端等着这批字节才能出画面。 */
                byte[] buf = new byte[131072];
                int n;
                while ((n = resp.stream.read(buf)) > 0) {
                    if (chunked) {
                        out.write((Integer.toHexString(n) + "\r\n").getBytes("UTF-8"));
                        out.write(buf, 0, n);
                        out.write("\r\n".getBytes("UTF-8"));
                    } else {
                        out.write(buf, 0, n);
                    }
                    out.flush();
                }
                if (chunked) {
                    out.write("0\r\n\r\n".getBytes("UTF-8"));
                    out.flush();
                }
                resp.stream.close();
            } else {
                byte[] body = resp.body;
                if (!resp.headers.containsKey("Content-Length")) {
                    resp.headers.put("Content-Length", String.valueOf(body.length));
                }
                head.append("Connection: close\r\n\r\n");
                out.write(head.toString().getBytes("UTF-8"));
                out.write(body);
                out.flush();
            }
            sock.close();
        } catch (Exception e) {
            Log.w(TAG, "处理请求出错 " + e.getMessage());
            try { sock.close(); } catch (IOException ignore) {}
        }
    }

    private static String statusText(int code) {
        switch (code) {
            case 200: return "OK";
            case 204: return "No Content";
            case 301: return "Moved Permanently";
            case 302: return "Found";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 404: return "Not Found";
            case 500: return "Internal Server Error";
            case 502: return "Bad Gateway";
            default: return "Status";
        }
    }

    private Req readRequest(InputStream in) throws IOException {
        String line = readLine(in);
        if (line == null || line.isEmpty()) return null;
        String[] parts = line.split(" ");
        if (parts.length < 2) return null;
        Req req = new Req();
        req.method = parts[0];
        String target = parts[1];
        int qIdx = target.indexOf('?');
        if (qIdx >= 0) {
            req.path = target.substring(0, qIdx);
            parseQuery(target.substring(qIdx + 1), req.query);
        } else {
            req.path = target;
        }

        while (true) {
            String h = readLine(in);
            if (h == null || h.isEmpty()) break;
            int c = h.indexOf(':');
            if (c > 0) {
                req.headers.put(h.substring(0, c).trim(), h.substring(c + 1).trim());
            }
        }

        String cl = req.headers.get("Content-Length");
        if (cl != null) {
            try {
                int len = Integer.parseInt(cl.trim());
                if (len > 0 && len < 10 * 1024 * 1024) {
                    byte[] b = new byte[len];
                    int off = 0;
                    while (off < len) {
                        int n = in.read(b, off, len - off);
                        if (n < 0) break;
                        off += n;
                    }
                    req.body = b;
                }
            } catch (NumberFormatException ignore) {}
        }
        return req;
    }

    private String readLine(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        while (true) {
            int c = in.read();
            if (c < 0) {
                if (bos.size() == 0) return null;
                break;
            }
            if (c == '\n') break;
            if (c != '\r') bos.write(c);
        }
        return bos.toString("UTF-8");
    }

    private void parseQuery(String raw, Map<String, String> q) {
        for (String kv : raw.split("&")) {
            int i = kv.indexOf('=');
            if (i < 0) continue;
            try {
                q.put(URLDecoder.decode(kv.substring(0, i), "UTF-8"),
                      URLDecoder.decode(kv.substring(i + 1), "UTF-8"));
            } catch (Exception ignore) {}
        }
    }

    // ---------------------------------------------------------------- 路由

    private Resp route(Req req) {
        String path = req.path;
        try {
            if (path.startsWith("/api/")) {
                return routeApi(req, path);
            }
            return serveAsset(path);
        } catch (Throwable t) {
            Log.e(TAG, "路由出错 " + path, t);
            return json(500, err("server error: " + t.getMessage()));
        }
    }

    private Resp routeApi(Req req, String path) {
        Map<String, String> q = req.query;
        JSONObject body = parseJsonBody(req);

        if (path.equals("/api/config")) {
            return handleConfig(req.method, body);
        } else if (path.equals("/api/test")) {
            return handleTest(body);
        } else if (path.equals("/api/browse")) {
            return handleBrowse(req.method, body, q);
        } else if (path.equals("/api/counts")) {
            return handleCounts(req.method, body, q);
        } else if (path.equals("/api/sources")) {
            return handleSources(body);
        } else if (path.equals("/api/library")) {
            return handleLibrary(q);
        } else if (path.equals("/api/state")) {
            return handleState(req.method, body);
        } else if (path.equals("/api/state/bulk")) {
            /* ⚠️ 必须排在 /api/state 的判断**之后**——不过这里是 equals 不是前缀匹配，
               顺序其实无所谓；写在一起只是为了让人一眼看到它俩是一对。 */
            return handleStateBulk(body);
        } else if (path.equals("/api/stream")) {
            return handleStream(req, q);
        } else if (path.equals("/api/transcode")) {
            return handleTranscode(req, q);
        } else if (path.equals("/api/probe")) {
            return handleProbe(q);
        } else if (path.equals("/api/warm")) {
            return handleWarm(q);
        } else if (path.equals("/api/demo")) {
            return json(200, demoPayload());
        } else if (path.equals("/api/thumb")) {
            return handleThumb(req, q);
        } else if (path.equals("/api/thumb/backfill")) {
            return handleThumbBackfill(body);
        } else if (path.equals("/api/thumb/stats")) {
            return handleThumbStats();
        } else if (path.equals("/api/strmjob")) {
            return handleStrmJob(req.method, body);
        } else if (path.equals("/api/strm/backup")) {
            return handleStrmBackup();
        } else if (path.equals("/api/strm/restore")) {
            return handleStrmRestore(req);
        } else if (path.equals("/api/strm/clear")) {
            return handleStrmClear(req.method);
        } else {
            return json(404, err("unknown api: " + path));
        }
    }

    private JSONObject parseJsonBody(Req req) {
        if (req.body == null || req.body.length == 0) return new JSONObject();
        try {
            return new JSONObject(new String(req.body, "UTF-8"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    // ---------------------------------------------------------------- 静态文件

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html; charset=utf-8");
        MIME.put("htm", "text/html; charset=utf-8");
        MIME.put("css", "text/css; charset=utf-8");
        MIME.put("js", "application/javascript; charset=utf-8");
        MIME.put("mjs", "application/javascript; charset=utf-8");
        MIME.put("json", "application/json; charset=utf-8");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("webp", "image/webp");
        MIME.put("gif", "image/gif");
        MIME.put("svg", "image/svg+xml");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("mp4", "video/mp4");
        MIME.put("ico", "image/x-icon");
    }

    private Resp serveAsset(String path) {
        String p = path.equals("/") ? "/index.html" : path;
        String assetPath = p.startsWith("/") ? p.substring(1) : p;

        InputStream is = null;
        try {
            is = ctx.getAssets().open(assetPath);
        } catch (IOException e) {
            if (!assetPath.contains(".")) {
                try { is = ctx.getAssets().open("index.html"); } catch (IOException e2) { is = null; }
            }
            if (is == null) return json(404, err("not found: " + path));
        }

        try {
            byte[] data = readAll(is);
            is.close();
            String ext = "";
            int dot = assetPath.lastIndexOf('.');
            if (dot >= 0) ext = assetPath.substring(dot + 1).toLowerCase();
            String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";

            Resp r = new Resp();
            r.status = 200;
            r.headers.put("Content-Type", mime);
            r.headers.put("Cache-Control", "no-cache");
            r.body = data;
            return r;
        } catch (IOException e) {
            return json(500, err("read asset failed"));
        }
    }

    // ---------------------------------------------------------------- 配置接口

    private Resp handleConfig(String method, JSONObject body) {
        if ("GET".equals(method)) {
            JSONObject o = new JSONObject();
            try {
                o.put("config", configJsonObj());
                o.put("hasPass", !pass.isEmpty());
                o.put("mode", isConfigured() ? "webdav" : "demo");
                o.put("dir", effectiveDir());
                // 前端靠这个决定「要不要后台预热时长」。探时长走系统解码器
                // （MediaMetadataRetriever），恒为 true（能不能读出时长是另一回事，
                // 读不出会返回 ok:false + "读不出时长"，前端据此标灰）。
                o.put("probe", true);
                /*
                 * ⚠️ `ffmpeg` 字段恒为 false —— 这是 Phase L 的**正确**取值，别去「修」它。
                 *
                 * 它问的是「这台设备上有没有真正的转码能力」。APK 里**没有 ffmpeg**
                 * （内嵌那套为了把 APK 从 40MB 压回 8MB 已经删掉），
                 * 也没有远端解码服务（那条路线 2026-09-18 已按用户要求整体回退）。
                 *
                 * 所以正确答案就是 false：**能播的片子靠原生解码直接播，不能播的就是不能播**，
                 * 前端照这个如实告诉用户，好过骗它说有转码能力然后转出一堆 404。
                 */
                o.put("ffmpeg", false);
                o.put("ffmpegPending", false);
                o.put("decoder", "native");
            } catch (Exception ignore) {}
            return json(200, o);
        }
        // POST：保存配置（与 server.js 一致）
        if (body.has("url")) { String u = body.optString("url", "").trim(); baseUrl = u.replaceAll("/+$", ""); }
        if (body.has("user")) user = body.optString("user", "");
        if (body.has("pass")) { String pp = body.optString("pass", ""); if (!pp.isEmpty()) pass = pp; }
        /* 🔴 这里原来是 `NasService.normAbs(d)` —— **就是它把 `local:/` 补成了 `/local:/`**，
           存进配置后 isLocalSrc 认不出来，于是 effectiveDir 的短路失效、越滚越脏。
           片源形态一律走 normSrc（它按 local: / WebDAV 分流）。 */
        if (body.has("dir")) { String d = body.optString("dir", ""); dir = d.trim().isEmpty() ? "" : normSrc(d); }
        if (body.has("dirs")) {
            JSONArray arr = body.optJSONArray("dirs");
            dirs = new ArrayList<>();
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    String s = arr.optString(i, "").trim();
                    if (!s.isEmpty()) dirs.add(normSrc(s));
                }
            }
        }
        if (body.has("skipDirs")) {
            JSONArray arr = body.optJSONArray("skipDirs");
            skipDirs = new ArrayList<>();
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    String s = arr.optString(i, "").trim();
                    if (s.isEmpty()) continue;
                    String n = normSrc(s);
                    if (dirs.contains(n) && !skipDirs.contains(n)) skipDirs.add(n);
                }
            }
        }
        if (body.has("recursive")) recursive = body.optBoolean("recursive", recursive);
        if (body.has("maxDepth")) maxDepth = clampDepth(body.optInt("maxDepth", maxDepth));
        // `playableOnly` 已废弃（片库固定列出 ALL_EXTS 全部格式），收到也不理
        if (body.has("fit")) fit = body.optString("fit", fit);
        if (body.has("nickname")) nickname = body.optString("nickname", nickname);
        // strm 自动库（2026-09-20）：与 dirs/skipDirs 同一套「只收传了的字段」原则。
        // 🔴 strmOut / strmLocal 都不再收：输出位置固定成 App 内目录（strmLocalDir()），
        //    前端也不该再发过来。收到也直接忽略（老版本前端发来不会把配置搞坏）。
        // 🔴 strmJobs 现在是**独立清单**，不再按「仍是片源子集」收敛（见字段头上 B 段）。
        //    它跟 dirs 已经没关系了，所以也不在乎放在 dirs 处理之前还是之后。
        if (body.has("strmJobs")) {
            JSONArray sa = body.optJSONArray("strmJobs");
            strmJobs = new ArrayList<>();
            if (sa != null) {
                for (int i = 0; i < sa.length(); i++) {
                    String s = sa.optString(i, "").trim();
                    if (s.isEmpty()) continue;
                    String n = NasService.normAbs(s);
                    if (!strmJobs.contains(n)) strmJobs.add(n);
                }
            }
        }
        if (body.has("strmIntervalH")) {
            // 0 = 仅手动；上限 168（一周）—— 再大的间隔没有意义，还容易让人误配
            strmIntervalH = Math.max(0, Math.min(168, body.optInt("strmIntervalH", 0)));
        }
        /* 体积阈值（MB，2026-09-22）。0 = 不限制。
           上限 102400（100 GB）纯粹是防手滑 —— 正常片源用不到，但填错一个大数
           会把整个库都跳过，给个天花板让「明显不合理」也落回可控范围。 */
        if (body.has("strmMinSizeMB")) {
            strmMinSizeMB = Math.max(0, Math.min(102400, body.optInt("strmMinSizeMB", 0)));
        }
        if (body.optBoolean("clearPass", false)) pass = "";
        persistConfig();
        strmSchedule();     // 间隔/监控项可能变了 → 按新配置重排定时任务（内部幂等）

        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("config", configJsonObj());
            o.put("hasPass", !pass.isEmpty());
            o.put("mode", isConfigured() ? "webdav" : "demo");
            o.put("dir", effectiveDir());
        } catch (Exception ignore) {}
        return json(200, o);
    }

    private JSONObject configJsonObj() {
        JSONObject o = new JSONObject();
        try {
            o.put("url", baseUrl);
            o.put("user", user);
            o.put("dir", dir);
            JSONArray d = new JSONArray();
            for (String s : dirs) d.put(s);
            o.put("dirs", d);
            JSONArray sd = new JSONArray();
            for (String x : skipDirs) sd.put(x);
            o.put("skipDirs", sd);
            o.put("recursive", recursive);
            o.put("maxDepth", maxDepth);
            o.put("fit", fit);
            o.put("nickname", nickname);
            // strm 自动库（2026-09-20）：前端设置页回填用。
            // 🔴 只回 `strmLocalDir()`（固定目录，给前端**只读展示**），不回 strmOut ——
            //    输出位置已经固定，没有可配的余地（见字段头上 A 段）。
            o.put("strmLocal", strmLocalDir());
            JSONArray sj = new JSONArray();
            for (String s : strmJobs) sj.put(s);
            o.put("strmJobs", sj);
            o.put("strmIntervalH", strmIntervalH);
            o.put("strmMinSizeMB", strmMinSizeMB);   // 体积阈值（2026-09-22）→ 前端回填
            /* 版本号（2026-09-20 用户要「以后每次打包都更新版本号」）。
             * 绑进 config 而不是新开一个 /api/version —— 「我的」页显示一行小字，
             * 不值得再开一个端点（一份 app.js 伺候两个后端，多一个端点就多一处分叉风险）。
             * ⚠️ 取值走 PackageManager，**不是** build.js 里那个字符串 ——
             *    APK 里真正生效的是 aapt2 打进 manifest 的那一份（见 build.js 的 --version-name），
             *    拿 PM 读等于直接读「用户手机上装的是哪版」，永远不会和实际不符。 */
            try {
                android.content.pm.PackageInfo pi = ctx.getPackageManager()
                        .getPackageInfo(ctx.getPackageName(), 0);
                o.put("versionName", pi.versionName == null ? "" : pi.versionName);
                o.put("versionCode", pi.versionCode);
            } catch (Throwable ignore) {}
        } catch (Exception ignore) {}
        return o;
    }

    // ---------------------------------------------------------------- 测试连接

    private Resp handleTest(JSONObject body) {
        applyCred(body);   // 用 body 里的 url/user/pass 测试
        if (!isConfigured()) return json(200, err("请先填写服务地址，例如 http://192.168.1.100:5005"));
        /* ⚠️ 注意这个三元：body 里**带了** dir（哪怕是空串）就按它来，只有**没带** dir 时才回落到 effectiveDir()。
         *    为什么强调这点：登录（两步流程的第 1 步）会显式传 dir=""，
         *    意思就是「我只想验证账号密码通不通，别拿我配置里那个可能已经失效的旧目录去试」。
         *    以前这里用 `!isEmpty()` 判断，空串会被当成「没传」→ 回落到 effectiveDir()
         *    → 拿config 里那条已删掉的旧挂载去 PROPFIND → 404 → **明明账号密码是对的，却报登录失败**。
         *    登录这一步用 `urlPath()`（服务地址里带的路径，通常就是 /）才是对的。 */
        // 空 dir → 探服务根：urlPath() 已经处理好了「地址带路径」的情况（`/dav`），
        // 地址没带路径才是真的根目录。
        String target;
        if (body.has("dir")) {
            String want = body.optString("dir", "");
            target = want.isEmpty() ? urlPath() : NasService.normAbs(want);
        } else {
            target = effectiveDir();
        }
        try {
            List<DavClient.Entry> raw = dav.propfind(target, "1");
            List<DavClient.Entry> items = new ArrayList<>();
            for (DavClient.Entry it : raw) {
                String rel = hrefToAbs(it.href);
                if (!rel.equals(NasService.normAbs(target))) items.add(it);
            }
            int dirsN = 0, filesN = 0, vidsN = 0;
            List<String> names = new ArrayList<>();
            for (DavClient.Entry it : items) {
                String rel = hrefToAbs(it.href);
                String name = NasService.baseNameOf(rel);
                if (it.isDir) { dirsN++; }
                else {
                    filesN++;
                    /* 这里用 isVideoExt（ALL_EXTS）：这是登录后「这个目录下有 N 个子文件夹、
                       M 个视频」的**原始盘点**，说的是磁盘上真有什么。
                       （与 server.js 的 /api/test 一致，别单边改。） */
                    if (NasService.isVideoExt(NasService.extOf(name))) vidsN++;
                }
                if (name != null && !name.isEmpty() && names.size() < 8) names.add(name);
            }
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("path", target);
            o.put("dirs", dirsN);
            o.put("files", filesN);
            o.put("vids", vidsN);
            JSONArray en = new JSONArray();
            for (String n : names) en.put(n);
            o.put("entries", en);
            return json(200, o);
        } catch (Exception e) {
            return json(200, err(e.getMessage()));
        }
    }

    // ---------------------------------------------------------------- 浏览目录

    private Resp handleBrowse(String method, JSONObject body, Map<String, String> q) {
        applyCred(body);
        if (!isConfigured()) return json(200, err("还没填 WebDAV 服务地址"));
        String rawPath;
        if ("POST".equals(method)) rawPath = body.optString("path", "");
        else rawPath = q.containsKey("path") ? q.get("path") : "";
        boolean implicit = rawPath.isEmpty();
        String target = implicit ? effectiveDir() : NasService.normAbs(rawPath);
        /* ⚠️ 本机片源（local:）时 effectiveDir() 返回**空串**（2026-09-20），
         *    这里 target 也就是空串 → listDir 会把它当归一到挂载根（`/dav`）——
         *    正好就是「本机片源没有 WebDAV 目录，那就从挂载根开始列」的语义，
         *    而且因为列得出来，**不会**掉进下面那个 healed 兜底弹提示。
         *    （旧写法把 `local:/` 污染成 `/dav/local:`，必然 404 → 弹一条
         *      莫名其妙的「文件夹找不到了」，用户压根没配过那种目录。） */

        try {
            return json(200, listDir(target));
        } catch (Exception e) {
            /* 空路径的语义是「用配置里那个目录」。而那个目录可能已经在 NAS 上没了
             * （被删 / 改名 / 换了服务器）—— 2026-09-18 的真实场景。
             * 这时人会掉进一个**出不来的死循环**：列表报 404，页面给的「回到根目录」
             * 按钮也是空路径，一点又回到同一个 404，于是永远挑不了文件夹。
             * 自愈：退到挂载根目录再列一次，能列出来就照常返回，另附 healed 标记
             * 让前端提醒人重挑。（与 doScan 的 staleRoots 兜底同一套思路，
             * 两个后端别分叉。） */
            if (implicit) {
                String pfx = prefixOf(baseUrl);
                String root = pfx.isEmpty() ? "/" : pfx;
                if (!root.equals(target)) {
                    try {
                        JSONObject info = listDir(root);
                        info.put("healed", true);
                        info.put("stalePath", target);
                        info.put("staleMsg",
                            "之前设的文件夹已经打不开了，已回到根目录，重新挑一个吧。");
                        Log.w(TAG, "browse 配置目录失效，已回退根目录 " + target + " → " + root);
                        return json(200, info);
                    } catch (Exception e2) {
                        Log.w(TAG, "browse 根目录兜底也失败 " + e2.getMessage());
                    }
                }
            }
            JSONObject o = new JSONObject();
            try {
                o.put("ok", false);
                o.put("path", target);
                o.put("error", e.getMessage());
            } catch (Exception ignore) {}
            return json(200, o);
        }
    }

    private JSONObject listDir(String absPath) throws Exception {
        /* 🔴 先归一到「含 urlPath 前缀」的坐标系（`mountAbs`）。
         *
         *    子路径挂载时 `/`（服务根）和 `/dav`（挂载根）指的是**同一层**，
         *    不归一会有两个后果，都很难看：
         *      ① `cp.equals(p)` 拿 `/dav`（href 里的真实路径）比 `/`（请求路径），
         *         永远不相等 → PROPFIND 回给自己的那条**没被排掉** →
         *         挂载根被列成一个叫「dav」的子文件夹（9 个而不是 8 个）；
         *      ② 面包屑/上一级按 `/` 算 → 走进一个「幽灵根」：面包屑空了，
         *         还能一直往上点，永远退不到真正的顶。
         *    2026-09-18 实测：在 `/dav` 点「上一级」就落到这个幽灵根上。
         *    （与 server.js 的 listDir 同一套判据，两边别分叉。） */
        String p = mountAbs(absPath);
        List<DavClient.Entry> raw = dav.propfind(p, "1");
        List<JSONObject> dirList = new ArrayList<>();
        List<JSONObject> vidList = new ArrayList<>();

        for (DavClient.Entry it : raw) {
            String cp = hrefToAbs(it.href);
            if (cp.isEmpty() || cp.equals(p)) continue;
            String name = NasService.baseNameOf(cp);
            if (name.isEmpty() || NasService.SKIP_DIR.matcher(name).find()) continue;

            if (it.isDir) {
                JSONObject d = new JSONObject();
                d.put("name", name);
                d.put("path", cp);
                d.put("count", JSONObject.NULL);
                dirList.add(d);
            } else {
                String ext = NasService.extOf(name);
                if (!NasService.isPlayableExt(ext)) continue;   // 播不了的（wmv/rmvb/mpg…）直接跳过不进片库（2026-09-19 用户要求）
                JSONObject v = new JSONObject();
                v.put("p", cp);
                v.put("name", name);
                v.put("size", it.size);
                v.put("mtime", it.mtime);
                v.put("ext", ext);
                v.put("playable", NasService.isPlayableExt(ext));
                String folder = NasService.folderOf(cp);
                v.put("folder", folder);
                v.put("title", name.replaceAll("\\.[^.]+$", ""));
                v.put("author", folder);
                vidList.add(v);
            }
        }

        Collections.sort(dirList, jsonCmp("name"));
        Collections.sort(vidList, jsonCmp("name"));

        JSONObject o = new JSONObject();
        o.put("ok", true);
        o.put("path", p);
        o.put("name", NasService.baseNameOf(p).isEmpty() ? "根目录" : NasService.baseNameOf(p));
        /* 挂载根就是可浏览树的顶 —— 它**没有**上一级。
         * 不这样钉住的话 parentOf("/dav") 会给出 "/"，前端「上一级」永远可点，
         * 点下去又落回同一层（甚至幽灵根）。根挂载时 p 就是 "/"，本来就 null。 */
        String mroot = prefixOf(baseUrl);
        if (mroot.isEmpty()) mroot = "/";
        String par = p.equals(mroot) ? null : parentOf(p);
        o.put("parent", par == null ? JSONObject.NULL : par);
        JSONArray cr = new JSONArray();
        for (String[] c : crumbsOf(p)) {
            JSONObject cc = new JSONObject();
            cc.put("name", c[0]);
            cc.put("path", c[1]);
            cr.put(cc);
        }
        o.put("crumbs", cr);
        JSONArray da = new JSONArray();
        for (JSONObject d : dirList) da.put(d);
        o.put("dirs", da);
        JSONArray va = new JSONArray();
        for (JSONObject v : vidList) va.put(v);
        o.put("videos", va);
        o.put("videoCount", vidList.size());
        return o;
    }

    private Comparator<JSONObject> jsonCmp(final String key) {
        return new Comparator<JSONObject>() {
            @Override public int compare(JSONObject a, JSONObject b) {
                String x = a.optString(key, "");
                String y = b.optString(key, "");
                return x.compareToIgnoreCase(y);
            }
        };
    }

    // ---------------------------------------------------------------- 统计

    private Resp handleCounts(String method, JSONObject body, Map<String, String> q) {
        applyCred(body);
        List<String> paths = new ArrayList<>();
        if ("POST".equals(method)) {
            JSONArray arr = body.optJSONArray("paths");
            if (arr != null) for (int i = 0; i < arr.length(); i++) paths.add(arr.optString(i));
        } else {
            String ps = q.containsKey("paths") ? q.get("paths") : "";
            for (String s : ps.split(",")) if (!s.trim().isEmpty()) paths.add(s);
        }
        JSONObject counts = new JSONObject();
        if (!isConfigured() || paths.isEmpty()) {
            JSONObject o = new JSONObject();
            try { o.put("ok", true); o.put("counts", counts); } catch (Exception ignore) {}
            return json(200, o);
        }
        for (int i = 0; i < Math.min(paths.size(), 24); i++) {
            String p = NasService.normAbs(paths.get(i));
            try {
                int n = countVideos(p);
                counts.put(p, n);
            } catch (Exception e) {
                try { counts.put(p, JSONObject.NULL); } catch (org.json.JSONException ignore) {}
            }
        }
        JSONObject o = new JSONObject();
        try { o.put("ok", true); o.put("counts", counts); } catch (Exception ignore) {}
        return json(200, o);
    }

    private int countVideos(String absPath) throws Exception {
        List<DavClient.Entry> raw = dav.propfind(absPath, "1");
        int n = 0;
        for (DavClient.Entry it : raw) {
            if (it.isDir) continue;
            String cp = hrefToAbs(it.href);
            String name = NasService.baseNameOf(cp);
            if (name.isEmpty()) continue;
            String ext = NasService.extOf(name);
            if (NasService.isPlayableExt(ext)) n++;   // 数片库会列出来的（播不了的格式不进片库也不算数）
        }
        return n;
    }

    // ---------------------------------------------------------------- 片源

    /**
     * 这次 /api/sources 请求是不是**只涉及本机片源**（local:）。
     *
     * 决定「没配 WebDAV 时要不要放行」（2026-09-20 晚）。换机的正常顺序是
     * 「装 App → 导入 strm 备份 → 再去填服务地址」，而备份里带的正是本机片源；
     * 这条请求如果因为「还没填地址」被拒，用户看到的就是「导入不生效」。
     *
     * 判据与 doScan 里逐 root 算的 `needDav` 同源（那边逐条判，这边整体判）：
     * 只要请求里有一条非 local: 的片源、或清空后本机其余片源里有非 local: 的，
     * 就仍然要求先配地址。
     */
    private boolean onlyLocalSrc(JSONObject body) {
        JSONArray arr = body.optJSONArray("dirs");
        if (arr != null) {
            if (arr.length() == 0) return true;      // 清空片源：什么都不用连，放行
            for (int i = 0; i < arr.length(); i++) {
                if (!isLocalSrc(arr.optString(i, "").trim())) return false;
            }
            return true;
        }
        return allDirsLocal();
    }

    /** 当前片源**非空且全部**是本机片源。见 onlyLocalSrc（注意与下面 hasLocalSrc 的区别）。 */
    private boolean allDirsLocal() {
        if (dirs.isEmpty()) return false;
        for (String d : dirs) if (!isLocalSrc(d)) return false;
        return true;
    }

    /** 当前片源里**有没有**本机片源（有一条就算）。给「不回演示模式」那个判断用。 */
    private boolean hasLocalSrc() {
        for (String d : dirs) if (isLocalSrc(d)) return true;
        return false;
    }

    private Resp handleSources(JSONObject body) {
        if (!isConfigured() && !onlyLocalSrc(body)) {
            return json(200, err("还没填 WebDAV 服务地址"));
        }
        JSONArray arr = body.optJSONArray("dirs");
        if (arr != null) {
            dirs = new ArrayList<>();
            for (int i = 0; i < arr.length(); i++) {
                String s = arr.optString(i, "").trim();
                if (!s.isEmpty()) dirs.add(normSrc(s));
            }
        }
        /* 🔒 「不重扫」的文件夹。只保留**仍在片源里**的项（文件夹都被移走了就别再记着），
         *    并顺手去重 —— 前端各自校验过一遍，后端必须再校验一次：
         *    /api/sources 是公开入口，不能指望调用方守规矩。 */
        if (body.has("skipDirs")) {
            JSONArray sa = body.optJSONArray("skipDirs");
            skipDirs = new ArrayList<>();
            if (sa != null) {
                for (int i = 0; i < sa.length(); i++) {
                    String s = sa.optString(i, "").trim();
                    if (s.isEmpty()) continue;
                    String n = normSrc(s);
                    if (dirs.contains(n) && !skipDirs.contains(n)) skipDirs.add(n);
                }
            }
        } else {
            // 没传就按新的 dirs 收敛一次（文件夹被删了，标记也得跟着没）
            List<String> keep = new ArrayList<>();
            for (String d : skipDirs) if (dirs.contains(d)) keep.add(d);
            skipDirs = keep;
        }
        if (body.has("recursive")) recursive = body.optBoolean("recursive", recursive);
        if (!dirs.isEmpty()) dir = dirs.get(0);
        persistConfig();

        /* 🔴 立刻回话，扫描丢后台 —— 2026-09-18「添加/移除文件夹反应太慢」的修复。
         *
         * 以前这里是 `mergeConfig(handleLibrary(force))`，force 里塞 refresh=1 ——
         * 也就是**同步**把整个片库重扫一遍才回。加一个 498 个视频的文件夹要 12~40 秒，
         * 界面全程卡在「正在扫描片源…」的转圈上，用户点一下等半分钟没动静。
         *
         * 但项目里早就有「先给旧数据撑住界面、后台慢慢扫、扫完通知前端换」这套机制
         * （startBackgroundScan + ?peek=1 + 前端 watchLibraryRefresh），
         * 缓存过期那条路一直在用，只有这里没接上。
         *
         * 所以现在：配置落盘 → 起后台扫描 → 马上回「配置已生效、片库还在扫」。
         * 前端拿到后立刻更新片源栏，靠 peek 轮询等结果，扫完自动换上并提示。
         *
         * ⚠️ 这里**刻意不动 libCache**：让它保持旧数据撑着界面（stale-while-revalidate），
         *    别让首页在扫描期间闪成「一条都没有」。旧的 libCacheSig 与新配置对不上，
         *    自然就不算「可用缓存」，不会脏读。
         * ⚠️ 也别 clearLibraryOnDisk()：扫挂了还得靠旧缓存兜底，而且盘上那份带的是旧 sig，
         *    下次启动 loadLibraryFromDisk 自己会判掉。 */
        if (dirs.isEmpty()) {
            // 片源被清空：没什么可扫的，直接把片库清干净。
            // 这一路必须**同步**给结果，否则旧的视频会一直挂在首页上。
            JSONObject empty = NasService.libraryJson(
                new ArrayList<NasService.Video>(), new ArrayList<String>(), 0, false);
            try {
                empty.put("source", "webdav");
                empty.put("demo", false);
                empty.put("configReady", true);
                empty.put("ageMs", 0);
                empty.put("ttlMs", LIB_TTL_MS);
                empty.put("scanning", false);
                empty.put("version", ++libVersion);
            } catch (Exception ignore) {}
            libCache = empty;
            libCacheAt = System.currentTimeMillis();
            libCacheSig = libSig();
            libScanError = "";
            clearLibraryOnDisk();
            return mergeConfig(json(200, empty));
        }

        startBackgroundScan();          // 单飞：已经在扫就直接复用那一轮
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("pendingScan", libScanning());
            o.put("scanning", libScanning());
            o.put("version", libVersion);
            /* dirs/dir 必须是**新配置**的：片源栏（renderSrcList / hasSrc）读的就是它。
             * 别从 libCache 里抄 —— 那是上一套片源。 */
            JSONArray nd = new JSONArray();
            for (String d : dirs) nd.put(d);
            o.put("dirs", nd);
            if (!dirs.isEmpty()) o.put("dir", dirs.get(0));
            if (libCache != null) {
                // 旧片库字段照带（videos 可能被别处用到），但 dirs/dir 已被上面覆盖成新的
                java.util.Iterator<String> it = libCache.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    if ("dirs".equals(k) || "dir".equals(k)) continue;
                    if (!o.has(k)) o.put(k, libCache.opt(k));
                }
            }
        } catch (Exception ignore) {}
        return mergeConfig(json(200, o));
    }

    /** 把当前 config 合并进一个 JSON 响应体里（handleSources 用；见上面的长注释） */
    private Resp mergeConfig(Resp r) {
        try {
            JSONObject o = new JSONObject(
                new String(r.body, java.nio.charset.StandardCharsets.UTF_8));
            o.put("config", configJsonObj());
            r.body = o.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.w(TAG, "合并 config 进 /api/sources 响应失败 " + e.getMessage());
        }
        return r;
    }

    // ---------------------------------------------------------------- 视频列表

    /**
     * 片库缓存状态（对应 server.js 的 library / libVersion / libSig）。
     *
     * ⚠️ **这是踩过大坑的地方**：前端每 4 秒轮询一次 `/api/library?peek=1`，
     * 如果 peek 也去做全量扫描，就等于「每 4 秒把整棵 NAS 目录树 PROPFIND 一遍」——
     * NAS 会被打爆，表现为「片源在、但一条视频都扫不出来 / 播不了」。
     * 所以 peek **绝不允许触发任何扫描**，只回报版本号。
     */
    private volatile JSONObject libCache = null;
    private volatile long libCacheAt = 0;
    private volatile int libVersion = 0;
    private volatile String libCacheSig = "";
    /**
     * 正在跑的扫描**层数**。
     *
     * ⚠️ 为什么是计数而不是一个布尔：有**两条**互不相干的路径会扫 ——
     *   · 后台那条链（`startBackgroundScan`，可能连扫好几轮「追新重扫」）
     *   · 同步那条（`scanNowSync`，用户点「重新扫描」/ 首次没缓存）
     * 用一个布尔的话，先结束的那条会把标志清成 false，另一条还在扫却对外说「没在扫」。
     * 后果很实际：`handleSources` 会回 `pendingScan:false`，前端就**拿旧片库去
     * applyLibrary** —— 又回到「首页闪空 / 正在看的被切走」那个坑；
     * 而且 `startBackgroundScan` 的单飞判断也会失灵，同时开两路全量扫描。
     * 2026-09-18 实测抓到的就是这个（logcat 里 `扫描期间片源又变了` 紧跟着
     * `同步扫描期间片源又变了`，之后 `scanning` 提前变 false）。
     */
    private final java.util.concurrent.atomic.AtomicInteger libScanDepth =
            new java.util.concurrent.atomic.AtomicInteger(0);
    /**
     * 后台那条「扫描 + 追新重扫」链有没有占着坑（单飞用）。
     * 和层数分开：层数是「有没有扫描在跑」（给 peek / pendingScan 看），
     * 这个是「后台链是不是已经在跑」（给 startBackgroundScan 判重用），两件事别混。
     */
    private volatile boolean libScanChained = false;

    /** 有没有扫描在跑（peek 的 scanning / /api/sources 的 pendingScan 用它） */
    private boolean libScanning() { return libScanDepth.get() > 0; }

    /**
     * 最近一次**后台**扫描的失败原因（扫成功就清掉）。对应 server.js 的 libError。
     * 只在 peek 响应里以 `scanError` 带回去 —— 前端拿到后直接弹提示并停止轮询。
     * ⚠️ 刻意不叫 `error`：那是「这份响应本身失败」的意思，而这里片库可能好好的，
     *    只是重扫没成功。混用会让前端 applySources 误报「扫描失败」。
     */
    private volatile String libScanError = "";
    /**
     * 片库缓存有效期 = 24 小时。
     * 24 小时内重开 App 直接读盘上的缓存，不再连 NAS 重扫（一次全扫要 10 秒左右）。
     */
    private static final long LIB_TTL_MS = 24 * 60 * 60 * 1000L;

    /** 片库缓存落盘位置：filesDir/library.json（不是 cacheDir —— 那个会被系统清掉） */
    private File libCacheFile() {
        return new File(ctx.getFilesDir(), "library.json");
    }

    /**
     * 启动时把上次扫好的片库读回来，省掉开机那一扫。
     * 走的是和 PC 版 server.js 一样的思路：配置签名对得上才认，配置一改就作废重扫。
     */
    private void loadLibraryFromDisk() {
        File f = libCacheFile();
        if (!f.isFile() || f.length() == 0) return;
        try {
            byte[] buf = new byte[(int) f.length()];
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            int n = 0;
            while (n < buf.length) {
                int r = in.read(buf, n, buf.length - n);
                if (r < 0) break;
                n += r;
            }
            in.close();
            JSONObject o = new JSONObject(new String(buf, 0, n, "UTF-8"));
            String sig = o.optString("sig", "");
            if (!sig.equals(libSig())) {
                Log.i(TAG, "片库缓存：配置变过，作废");
                f.delete();
                return;
            }
            JSONObject lib = o.optJSONObject("lib");
            if (lib == null) return;
            long at = o.optLong("at", 0);
            libCache = lib;
            libCacheAt = at;
            libCacheSig = sig;
            libVersion++;
            Log.i(TAG, "片库缓存：读回 " + countVideos(lib) + " 个视频，"
                    + Math.round((System.currentTimeMillis() - at) / 60000) + " 分钟前扫的");
        } catch (Throwable t) {
            Log.w(TAG, "片库缓存读取失败，忽略 " + t.getMessage());
        }
    }

    /** 扫描成功后把片库写到盘上，下次启动直接用 */
    private void saveLibraryToDisk(JSONObject lib, String sig) {
        File f = libCacheFile();
        File tmp = new File(f.getParentFile(), "library.json.part");
        try {
            JSONObject o = new JSONObject();
            o.put("sig", sig);
            o.put("at", System.currentTimeMillis());
            o.put("lib", lib);
            FileOutputStream os = new FileOutputStream(tmp);
            os.write(o.toString().getBytes("UTF-8"));
            os.flush();
            os.close();
            // 先写 .part 再改名：中途被杀不会留下半份坏缓存
            if (!tmp.renameTo(f)) {
                try { f.delete(); } catch (Throwable ignore) {}
                if (!tmp.renameTo(f)) {
                    java.io.FileInputStream in = new java.io.FileInputStream(tmp);
                    FileOutputStream os2 = new FileOutputStream(f);
                    byte[] b = new byte[8192];
                    int r;
                    while ((r = in.read(b)) > 0) os2.write(b, 0, r);
                    in.close(); os2.close();
                    tmp.delete();
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "片库缓存落盘失败 " + t.getMessage());
            try { tmp.delete(); } catch (Throwable ignore) {}
        }
    }

    /** 清掉盘上的片库缓存（重扫拿到空结果 / 配置变了时用） */
    private void clearLibraryOnDisk() {
        try { libCacheFile().delete(); } catch (Throwable ignore) {}
    }

    /** 配置签名：配置一变就必须重扫（对应 server.js 的 libSig） */
    private String libSig() {
        StringBuilder sb = new StringBuilder();
        sb.append(baseUrl).append('|').append(user).append('|');
        for (String d : dirs) sb.append(d).append(',');
        sb.append('|');
        sb.append('|').append(recursive).append('|').append(maxDepth);
        /* 把片库格式清单**本身**拼进签名：改清单（2026-09-19 放开 mkv、随后又按用户要求
           跳过 avi/wmv/rmvb）都会**自动作废旧缓存** —— 否则旧缓存里那些不该出现的
           wmv/rmvb 会被原样读回来，用户得等到 TTL 过期才看不见它们。 */
        sb.append('|');
        for (String e : NasService.PLAYABLE_EXTS) sb.append(e).append(',');
        /* ⚠️ 签名里**刻意不含** skipDirs（2026-09-18）。
           一旦把它拼进来，勾选/取消「不重扫」就会让整份片库缓存失效 ——
           而跳过的那些目录正是要靠这份缓存才有视频的，等于自己把自己清空了。
           勾选项改变时的正确性由 doScan 按目录维度合并来保证：
             取消勾选 → 那一轮会真扫它，新结果自然覆盖缓存里的旧记录；
             刚勾选   → 上一轮刚扫过，缓存里就是最新的，直接用。 */
        return sb.toString();
    }

    private static int countVideos(JSONObject lib) {
        if (lib == null) return 0;
        JSONArray a = lib.optJSONArray("videos");
        return a == null ? 0 : a.length();
    }

    /**
     * 把「当前配置里的片源」覆盖进一份片库响应（2026-09-20）。
     *
     * 🔴 片库（videos）是**内容缓存**，片源（dirs/dir）是**配置** —— 两码事，别混着走。
     *    缓存里那份 dirs 是「那一轮扫描的目标」的历史值：
     *      · 片源为空时 → defaultRoots() 兜底成 WebDAV 挂载根（CD2 上是 `/dav`）；
     *      · 配置目录在 NAS 上全失效时 → 再退一级兜底成 `/`。
     *    把这些历史值原样回给前端，前端的 applyLibrary 会同步进 `S.config.dirs`，
     *    表现就是「重启几次后 dav 根目录自己出现在片源里」（用户 2026-09-20 报的 bug）。
     *    而且**磁盘上那份缓存已经带着错值**，光改 doScan 不够 —— 装上修复版后
     *    如果命中缓存，还是会拿旧的错 dirs 回话。所以只要是从缓存回传的路径，
     *    都用当前配置覆盖一次。（doScan 刚扫出来的那份也该覆盖：幂等，且能兜住
     *    「扫描途中配置变了」这种边角。）
     */
    private void putLiveSrc(JSONObject o) {
        if (o == null) return;
        try {
            JSONArray a = new JSONArray();
            for (String d : dirs) a.put(d);
            o.put("dirs", a);
            /* dir 与 dirs 同口径：没片源就给空串，别留着上一套的 dir —— 否则前端的
               「当前目录」会挂在一个配置里已经不存在的路径上。 */
            o.put("dir", dirs.isEmpty() ? "" : dirs.get(0));
        } catch (Exception ignore) {}
    }

    private Resp handleLibrary(Map<String, String> q) {
        boolean peek = "1".equals(q.get("peek"));
        boolean refresh = "1".equals(q.get("refresh"));

        // ---- 轮询路径：只回报版本，绝不扫描 ----
        if (peek) {
            int v = -1;
            try { v = Integer.parseInt(q.get("v")); } catch (Exception ignore) {}
            JSONObject cached = libCache;
            boolean changed = cached != null && v != libVersion;
            JSONObject o = new JSONObject();
            try {
                o.put("ok", true);
                o.put("version", libVersion);
                o.put("changed", changed);
                o.put("count", countVideos(cached));
                o.put("scanning", libScanning());
                if (changed) {
                    // 版本变了才带上完整片库（前端换上新内容）
                    java.util.Iterator<String> it = cached.keys();
                    while (it.hasNext()) { String k = it.next(); o.put(k, cached.opt(k)); }
                    /* 版本变化也可能是**后台扫描失败**造成的（失败也会 +版本，
                     * 否则前端要一直空等到超时）。这时没有新片库可换，
                     * 把原因带回去让前端直接弹提示、并且**别再**去拉一次完整片库
                     * （那一趟是同步重扫，白等十几秒，大概率再失败一次）。
                     * 对应 server.js libPayload() 里的 scanError。 */
                    if (libScanError != null && !libScanError.isEmpty()) {
                        o.put("scanError", libScanError);
                    }
                    putLiveSrc(o);      // 缓存里那份 dirs 是历史扫描目标，用当前配置盖掉
                }
            } catch (Exception ignore) {}
            return json(200, o);
        }

        // ---- 普通请求：签名没变 + 缓存没过期 → 直接给缓存，别重扫 ----
        String sig = libSig();
        JSONObject cached = libCache;
        long age = System.currentTimeMillis() - libCacheAt;
        boolean sigOk = cached != null && sig.equals(libCacheSig);
        if (sigOk && age < LIB_TTL_MS && !refresh) {
            JSONObject o = new JSONObject();
            try {
                java.util.Iterator<String> it = cached.keys();
                while (it.hasNext()) { String k = it.next(); o.put(k, cached.opt(k)); }
                o.put("ageMs", age);
                o.put("cached", true);
                putLiveSrc(o);      // 缓存里的 dirs 可能是兜底值（/dav、/），别让它当片源
            } catch (Exception ignore) {}
            return json(200, o);
        }

        // ---- 缓存过期了，但还认这个配置：先把旧列表秒回去，重扫丢到后台 ----
        // 过期不等于要卡住用户。先给一份「旧的但可用」的列表，App 瞬间就能用；
        // 后台扫完 libVersion++，前端那套 ?peek=1 轮询会发现版本变了、自动换上新的。
        // 只有用户主动点「重新扫描」（refresh=1）才同步等 —— 那次他就是想看最新结果。
        if (sigOk && !refresh) {
            startBackgroundScan();
            JSONObject o = new JSONObject();
            try {
                java.util.Iterator<String> it = cached.keys();
                while (it.hasNext()) { String k = it.next(); o.put(k, cached.opt(k)); }
                o.put("ageMs", age);
                o.put("cached", true);
                o.put("stale", true);       // 告诉前端「这是旧的，正在后台更新」
                o.put("scanning", true);
                putLiveSrc(o);      // 同上：旧缓存的 dirs 一律用当前配置覆盖
            } catch (Exception ignore) {}
            return json(200, o);
        }

        /* 🔴 只有本机片源时不回演示模式（2026-09-20 晚）：local: 走 java.io.File 枚举，
           压根不需要 dav —— 换机的正常顺序是「装 App → 导 strm 备份（片源是 local:）
           → 再去填服务地址」，这时回 demoPayload 等于把那批 .strm 全判成「没有内容」，
           用户看到的就是「导入不生效」。
           ⚠️ 片源真的空的时候仍回 demo —— 那是「什么都还没配」的初始状态，别动。 */
        if (!isConfigured() && !hasLocalSrc()) return json(200, demoPayload());
        /* 走到这里 = 用户主动点「重新扫描」（refresh=1）或首次没缓存。
         *
         * 🔴 2026-09-18：**不再同步等**。深扫（不限深度）实测要 **13 分钟**
         *    （/dav/示例片源 一个片源就从 549 扫到 **5496** 个视频）。
         *    以前这里 `return scanNowSync()` —— HTTP 请求挂 13 分钟才回，
         *    WebView 那边看着跟死机一样，用户根本不知道是在扫还是断了。
         *    现在改成**也走后台**：立刻回话 + `scanning:true` + `pendingScan:true`，
         *    前端那套 ?peek=1 轮询（watchLibraryRefresh）扫完自动换上新内容。
         *
         * ⚠️ 配套：前端轮询上限原来是 75×4s = 5 分钟，**不够**，已放宽到 20 分钟。
         *    两边必须一起改，只改一边 = 扫完没人接得住。
         *
         * 手上要是已经有旧片库，就先把它带回去（前端不会闪空）；
         * 没有（首次启动）就回一个空壳，同样靠轮询补上。 */
        startBackgroundScan();
        JSONObject o = new JSONObject();
        try {
            if (cached != null) {
                java.util.Iterator<String> kit = cached.keys();
                while (kit.hasNext()) { String k = kit.next(); o.put(k, cached.opt(k)); }
            } else {
                o.put("videos", new JSONArray());
                o.put("count", 0);
                o.put("source", "webdav");
                o.put("configReady", true);
            }
            o.put("cached", true);
            o.put("stale", true);          // 这是旧的，正在后台更新
            o.put("scanning", true);
            o.put("pendingScan", true);    // 前端见这个标志就**不要** applyLibrary
            o.put("version", libVersion);
            putLiveSrc(o);      // 同上：这里回的是上一套片库，dirs 必须用当前配置
        } catch (Exception ignore) {}
        return json(200, o);
    }

    /**
     * 同步扫一遍，把结果交给前端（「重新扫描」/ 首次没缓存走这条）。
     *
     * 里面套了个小循环：扫描期间片源被改了，doScan 会返回 superseded 而不是提交结果
     * （见 doScan 里那段长注释），这时按最新配置再扫一次 ——
     * 否则前端会收到一个既没有 videos 也没有 error 的空壳。
     *
     * ⚠️ 扫描「层数」的加减由这里负责（doScan 自己不管了）：
     *    后台那条链中途不能松手，同步这条走完必须松手。
     *    用计数而不是布尔 —— 两条路可能重叠，布尔会被先结束的那条清掉（见 libScanDepth 注释）。
     */
    private JSONObject scanNowSync() {
        libScanDepth.incrementAndGet();
        try {
            for (int round = 0; round < 3; round++) {
                String sig = libSig();
                JSONObject lib = doScan(sig);
                if (lib == null || !lib.optBoolean("superseded", false)) return lib;
                Log.i(TAG, "同步扫描期间片源又变了，按新配置重扫");
            }
            return doScan(libSig());
        } finally {
            libScanDepth.decrementAndGet();
        }
    }

    /**
     * 把整个 NAS 扫一遍，更新缓存并落盘。
     *
     * 抽出来是因为「缓存过期后先给旧的、后台再扫」也要走同一套逻辑 ——
     * 两条路径各写一份迟早会不一致（而且那些错误处理很容易漏）。
     */
    /**
     * 上一份片库里**属于某个目录**的视频（供「不重扫」的文件夹直接复用）。
     *
     * ⚠️ 判前缀必须带 `/`：`/dav/示例片源2` 不能被当成 `/dav/示例片源` 的子项。
     * ⚠️ 读的是 **libCache**（内存里那份），不是磁盘：磁盘那份可能还没落盘。
     */
    private List<NasService.Video> cachedVideosOfDir(String dir) {
        List<NasService.Video> out = new ArrayList<>();
        if (libCache == null) return out;
        JSONArray a = libCache.optJSONArray("videos");
        if (a == null) return out;
        String d = normSrc(dir);
        for (int i = 0; i < a.length(); i++) {
            JSONObject jo = a.optJSONObject(i);
            if (jo == null) continue;
            String p = jo.optString("p", "");
            if (p.isEmpty()) continue;
            if (!p.equals(d) && !p.startsWith(d + "/")) continue;
            NasService.Video v = NasService.Video.fromJson(jo);
            if (v != null) out.add(v);
        }
        return out;
    }

    /**
     * 这个扫描错误是「认证 / 限流」类吗？
     *
     * 🔴 为什么要单独认它（2026-09-19 实测踩到，现象非常隐蔽）：
     *    内置 OpenList 有一道**登录限流**（`model.LoginCache`，5 次失败锁 5 分钟），
     *    而**每次再撞都会把那 5 分钟续上**。而本机的数据源就是它 ——
     *    用户在设置页把密码固定成自己设的之后，App 配置里存的旧密码就失效了，
     *    于是**每轮扫描都会认证失败好几次**（每个片源目录 + 根目录兜底各算一次），
     *    几秒内就把锁打满：**连管理页都登不进去**（登录接口走同一道锁），
     *    而且越重启越锁 —— 用户看到的是「改完密码就废了」。
     *
     *    所以要认出它，并**立刻放弃整轮扫描**，别接着试下一个目录、更别回退到根目录再撞一遍。
     *
     * 判据：`DavClient` 抛的是 `IOException("WebDAV " + code + ...)`。
     * 403 也一起算（云盘类 WebDAV 会把「token 过期」报成 403）。
     */
    private static boolean isAuthOrLimitError(String msg) {
        if (msg == null) return false;
        return msg.contains("WebDAV 401") || msg.contains("WebDAV 403") || msg.contains("WebDAV 429");
    }

    private JSONObject doScan(String sig) {
        long t0 = System.currentTimeMillis();
        /* 片源重扫 = 目录结构可能变了 → strm 解析缓存整体作废（下次播放重新读文件）。
         * 重扫本来就要打一轮 115 API，不差这几下；换来的是「strm 内容改了立刻生效」。 */
        strmCacheClear();
        List<NasService.Video> all = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        boolean truncated = false;
        final boolean[] scanTruncated = new boolean[1];   // 由 NasService.scan 回传「撞没撞上限」
        String firstErr = null;
        List<String> labels = new ArrayList<>();

        // ---- 群晖 WebDAV 片源 ----
        /* ⚠️ 2026-09-18 血泪：**配置里记着的目录可能在 NAS 上已经被删了**。
         *    真实场景：NAS 端服务器改不了，`config` 里那条旧挂载（远程挂载/webdav/…）
         *    后来从 NAS 上消失了，PROPFIND 返回 404 → 每次扫描**整体失败** →
         *    首页永远「连不上 NAS」，而人又删不掉那条配置，等于被永久卡死。
         *    所以这里做**自愈**：所有配置目录都探不到时，回退到根目录再试一次；
         *    能扫到东西就照常返回，并把「旧目录已失效」作为可操作提示带上。 */
        boolean staleRoots = false;
        /* 认证/限流类错误一出现就置位 → 立刻放弃整轮扫描（见 isAuthOrLimitError） */
        boolean authFailed = false;
        /* 🔴 用户配置的片源**快照**（2026-09-20 修 bug）—— 结尾回给前端的 `dirs`
         *    必须是「用户配的片源」，**不是**「这一轮实际扫了什么」。
         *
         * 两者只在正常情况下才相等。两种会分岔的情形：
         *   · `dirs` 为空（用户从没加过片源 / 清空过）→ 走 defaultRoots() 兜底扫根目录；
         *   · 配置的目录在 NAS 上全失效 → 再退一级、直接用 "/" 兜底（见下面 staleRoots）。
         * 这些 roots **全是扫描目标，不是片源**。
         *
         * 老代码在结尾 `libraryJson(all, labels, …)` 把 labels（= roots）当 dirs 回传，
         * 前端 applyLibrary 又把它同步进 `S.config.dirs` —— 于是**每次重启**
         * （重启必拉一次 /api/library）dav 根目录都会「自己」出现在片源里，
         * 而用户根本没点过「＋ 加入」。2026-09-20 用户报的就是这个。
         *
         * ⚠️ 快照必须在 `labels.clear()` 之前拿 —— 下面 staleRoots 那段会把 labels 改成 "/"。 */
        final List<String> cfgDirs = new ArrayList<>(dirs);
        /* 🔴 不能再用 `dav != null` 当总闸（2026-09-20）：
           本机片源（local:）**不需要任何 WebDAV 连接** —— 用户完全可能「只把 strm
           生成到手机本地、当个纯本地播放器用」，没配或配错 WebDAV 时那些 strm
           照样该能刷出来。把闸门放在「这个 root 需要不需要 dav」上，
           而不是「有没有 dav」上。 */
        {
            List<String> roots = dirs.isEmpty() ? defaultRoots() : dirs;
            labels.addAll(roots);
            for (String root : roots) {
                boolean needDav = !isLocalSrc(root);
                if (needDav && dav == null) {
                    if (firstErr == null) firstErr = "还没填 WebDAV 服务地址";
                    continue;
                }
                /* 🔒 「不重扫」的文件夹：跳过这次扫描，直接把上一份片库里属于它的视频搬过来。
                 *    ⚠️ 只在**缓存里确实有它的视频**时才跳过 —— 一次都没扫过（新装的、
                 *    缓存被清了、刚加上的）就必须照常扫一遍，否则用户标完发现这个文件夹
                 *    一条都没有，只会以为坏了。
                 *    想强制重扫它有现成入口：片源栏那个「只刷它」。 */
                if (skipDirs.contains(root)) {
                    List<NasService.Video> old = cachedVideosOfDir(root);
                    if (!old.isEmpty()) {
                        for (NasService.Video v : old) {
                            if (seen.add(v.p)) all.add(v);
                        }
                        Log.i(TAG, "跳过「不重扫」的 " + root + "，复用上次 " + old.size() + " 个视频");
                        continue;
                    }
                    Log.i(TAG, root + " 标了「不重扫」但片库里没有它 —— 首次照扫一次");
                }
                try {
                    /* 本机片源（local:）走 java.io.File 枚举，**不能**送进 PROPFIND ——
                       它的路径形状和 WebDAV 一样，但压根不在 CD2 上，送去必然 404。
                       见 LOCAL_PREFIX 的长注释。 */
                    List<NasService.Video> list;
                    if (isLocalSrc(root)) {
                        String disk = localAbs(root);
                        if (disk == null) {
                            Log.w(TAG, "本机片源路径非法，跳过 " + root);
                            continue;
                        }
                        list = NasService.scanLocal(new java.io.File(disk), LOCAL_PREFIX,
                                new java.io.File(strmLocalDir()).getAbsolutePath(),
                                recursive, maxDepth, scanTruncated);
                    } else {
                        list = NasService.scan(dav, root, recursive, maxDepth, scanTruncated);
                    }
                    for (NasService.Video v : list) {
                        if (seen.add(v.p)) all.add(v);
                    }
                } catch (Exception e) {
                    if (firstErr == null) firstErr = e.getMessage();
                    Log.w(TAG, "片源扫描失败 " + root + " " + e.getMessage());
                    /* 🔴 认证/限流类错误**立刻放弃整轮**：接着试下一个目录、
                       甚至回退到根目录再撞一遍，只会把内置 OpenList 的登录锁越锁越久。 */
                    if (isAuthOrLimitError(e.getMessage())) {
                        authFailed = true;
                        Log.w(TAG, "认证/限流类错误，放弃本轮剩余目录，不再重试以免加重限流");
                        break;
                    }
                }
            }
            // 一条配置目录都没扫出东西 → 多半是目录没了/改名了。退到根目录兜底。
            /* ⚠️ authFailed 时不兜底：那是密码/限流问题，换路径再试一次纯属白撞。
               ⚠️ 没有 dav 时也不兜底（2026-09-20）：那就没有「WebDAV 根目录」可退，
                  硬扫会 NPE。这种情况 firstErr 会记着「还没填 WebDAV 服务地址」，
                  由下面「全部失败」那条分支把话传给用户。 */
            if (all.isEmpty() && firstErr != null && !authFailed && dav != null) {
                staleRoots = true;
                Log.w(TAG, "配置的片源目录全部失效，回退到 WebDAV 根目录兜底：" + firstErr);
                try {
                    List<NasService.Video> list =
                        NasService.scan(dav, "/", recursive, maxDepth, scanTruncated);
                    if (!list.isEmpty()) {
                        for (NasService.Video v : list) {
                            if (seen.add(v.p)) all.add(v);
                        }
                        labels.clear();
                        labels.add("/");
                    }
                } catch (Exception e2) {
                    Log.w(TAG, "根目录兜底也失败 " + e2.getMessage());
                }
            }
        }

        /* 🔴 时间截断以前**完全不报告** —— 45 秒一到静悄悄停下，
         *    truncated 还是 false，用户以为扫全了。现在由 scan 回传。 */
        if (all.size() >= NasService.MAX_VIDEOS) truncated = true;
        if (scanTruncated[0]) truncated = true;

        /* 🔴 扫的中途配置又变了（用户手快，刚加的文件夹还没扫完又加了一个）：
         * 这份结果已经对不上号，**绝不能提交** —— 成功不提交、失败也不报错。
         *
         * 为什么不能「先提交再重扫」：提交会让 libVersion++，而前端那套 ?peek=1 轮询
         * 一看到版本变化就取走这份过期数据**并停止轮询** —— 后面那轮正确的结果
         * 就再也没人看了，界面永久停在半路上。失败同理：把一个「上一个片源」的报错
         * 甩给用户，只会让人对着一个已经改掉的问题白折腾。
         *
         * 所以这里返回 superseded 标记、什么都不做，由调用方按新配置再扫一轮。
         * （对应 server.js 的 kickBackgroundScan 里那个 `sig !== libSig()` 判断。）
         * ⚠️ 位置很关键：必须在下面「全部失败」那个分支**之前** —— 否则失败路径会
         *    先 libVersion++ 再 return，superseded 就轮不到了。 */
        if (!sig.equals(libSig())) {
            Log.i(TAG, "扫描期间片源又变了，本轮结果作废（不提交、不 +版本）");
            JSONObject sup = new JSONObject();
            try { sup.put("superseded", true); } catch (Exception ignore) {}
            return sup;
        }

        if (all.isEmpty() && firstErr != null) {
            // 全部失败：返回结构化错误，让前端给「连不上」的人话提示（不缓存，下次重试）
            JSONObject errObj = demoPayload();
            try {
                errObj.put("videos", new JSONArray());
                errObj.put("source", "webdav");
                errObj.put("demo", false);
                errObj.put("configReady", true);
                /* 配置目录失效（根目录探过说明是**路径**问题，不是连不上/没权限）：
                 * 别把原始 404 甩出去，直接告诉人下一步做什么 ——
                 * 「重新登录 + 换个文件夹」是这种情况下唯一走得通的动作。
                 * 与 Node 版 buildLibrary 的判据保持一致。 */
                if (staleRoots) {
                    errObj.put("stale", true);
                    errObj.put("error", "片源文件夹已经打不开了（可能被删或改名）。"
                            + "去「设置」重新登录，再挑一个文件夹。");
                } else if (authFailed) {
                    /* 别把「WebDAV 429」这种原文甩给用户 —— 他看不懂，也不知道该做什么。
                       这里要说清两件事：**哪儿出的问题**，以及**去哪儿改**。

                       🔴 2026-09-20 实测踩到的坑：默认文案只说「密码不对」，
                       而 401 最常见的原因其实是**内置引擎里 CD2 账号根本没登录** —
                       那种情况下 WebDAV 一律 401，**密码是对的**，用户按提示反复重填
                       密码只会原地打转（甚至把登录锁撞满）。两种情况要分开指引。 */
                    if (isLocalCd2Dav()) {
                        /* 连的是本机内置引擎：先怀疑「引擎没登录 CD2 账号」。
                           引擎的 WebDAV 凭据 = CD2 的登录账号，引擎里没登录就谁都进不来。 */
                        errObj.put("error", "内置网盘的 WebDAV 拒绝了这个账号 —— 最常见的原因是"
                                + "内置引擎里还没登录 CD2 账号（或登录已过期）。"
                                + "先回「我的 → 数据源设置」第 1 步点「打开 CloudDrive2 管理」，"
                                + "在管理页登录你的 CD2 账号并挂载网盘，再用同一组账号密码登录。");
                        errObj.put("engineLogin", true);   // 前端据此把「打开管理页」按钮亮出来
                    } else {
                        errObj.put("error", "WebDAV 账号或密码不对（或短时间内重试太多被暂时限流）。"
                                + "去「我的 → 数据源设置」重新填密码并登录。");
                    }
                } else {
                    errObj.put("error", firstErr);
                }
            } catch (Exception ignore) {}
            /* 扫挂了也得让 libVersion 动一下 —— 前端只在版本变化时才去取结果，
             * 不动它就只会一直空等到超时，用户看到的是「永远在扫」。
             * 原因记进 libScanError，peek 会以 scanError 带回去让前端直接弹提示。 */
            libScanError = errObj.optString("error", String.valueOf(firstErr));
            libVersion++;
            return errObj;
        }
        long elapsed = System.currentTimeMillis() - t0;
        /* 🔴 传 `cfgDirs`（用户配的片源），**不是** `labels`（本轮扫描目标）。
         *    两者会在「片源为空走兜底」和「配置目录失效退到根」时分岔，
         *    而前端会把这个字段同步进 S.config.dirs 当片源显示 —— 见 doScan 开头
         *    cfgDirs 那段长注释与 2026-09-20 的「dav 根自动进片源」bug。 */
        JSONObject lib = NasService.libraryJson(all, cfgDirs, elapsed, truncated);
        try { lib.put("scannedRoots", new JSONArray(labels)); } catch (Exception ignore) {}
        libVersion++;
        libScanError = "";
        try {
            lib.put("demo", false);
            lib.put("configReady", true);
            lib.put("ageMs", 0);
            lib.put("ttlMs", LIB_TTL_MS);
            lib.put("version", libVersion);
            lib.put("cached", false);
            lib.put("scanning", false);
            lib.put("source", "webdav");
            /* 配置目录失效、已经用根目录兜底扫出东西了 —— 前端据此提示
             * 「之前那个文件夹没有了，去设置里重新登录挑一个」。
             * 不报成 error：东西已经扫出来了，能看；只是要提醒人去改配置。 */
            if (staleRoots) {
                lib.put("staleRoots", true);
                lib.put("staleMsg", "之前设的文件夹已经打不开了（可能被删或改名），"
                        + "已临时从根目录开始扫。去「设置」重新登录并挑一个文件夹。");
            }
        } catch (Exception ignore) {}
        // 存缓存，供 ?peek=1 轮询与后续请求复用。
        libCache = lib;
        libCacheAt = System.currentTimeMillis();
        libCacheSig = sig;
        saveLibraryToDisk(lib, sig);     // 落盘：下次启动直接读，不用重扫
        /* ⚠️ 这里**不再**动扫描层数（libScanDepth）。原因：后台那条路是
         *    「扫描 + 追新重扫」一整条链，doScan 中途减一就等于松手，别的请求
         *    挤进来就会同时开两路扫描。加减由调用方统一负责：
         *    startBackgroundScan 的 finally / scanNowSync 的 finally。 */
        return lib;
    }

    /**
     * 后台重扫（片源变更后 / 缓存过期后自动触发）。
     *
     * 两个用途：
     *   · GET /api/library 发现缓存过期 → 先回旧列表，这里悄悄重扫；
     *   · POST /api/sources 改完片源 → 立刻回话，这里把扫描接过去（见 handleSources）。
     *
     * ⚠️ 必须在**起线程之前**就把坑占住（`libScanChained` + 层数一起）：
     *    进线程是异步的，两个请求前后脚进来会双双通过这里的检查，同时开两路扫描
     *    （前端每几秒 peek 一次，很容易撞上）。
     *    ⚠️ 判重用的是 `libScanChained` 而**不是**层数：同步扫描（scanNowSync）
     *    也会把层数加一，拿层数判重会让「后台该扫的时候扫不了」。
     */
    private void startBackgroundScan() {
        synchronized (libScanLock) {
            if (libScanChained) return;              // 后台链已经在跑，复用那一条
            libScanChained = true;                   // 先把坑占住，再起线程
            libScanDepth.incrementAndGet();
        }
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Log.i(TAG, "片源变更/片库缓存过期，后台重扫中…");
                    /* 单飞 + 追新：扫的中途用户又改了片源，这轮结果就对不上号了 ——
                     * doScan 会返回 superseded（它自己不提交），这里按最新配置再扫一轮。
                     * 没有这一步的话，后一次改动会**永远等不到结果**：
                     * 前端只在 libVersion 变化时取一次片库，而 libVersion 只在提交那一刻 +1。 */
                    for (int round = 0; round < 3; round++) {
                        String sig = libSig();
                        JSONObject lib = doScan(sig);
                        if (lib == null || !lib.optBoolean("superseded", false)) {
                            Log.i(TAG, "后台重扫完成，共 " + countVideos(libCache) + " 个视频");
                            return;
                        }
                        Log.i(TAG, "扫描期间片源又变了，丢弃本轮结果并按新配置重扫");
                    }
                    Log.w(TAG, "片源反复变动，本轮后台扫描放弃");
                } catch (Throwable e) {
                    Log.w(TAG, "后台重扫失败 " + e.getMessage());
                    // 异常也要让前端有回音，否则 peek 会一直空等到超时
                    libScanError = String.valueOf(e.getMessage());
                    libVersion++;
                } finally {
                    // 整条链（扫描 + 追新重扫）结束才松手，中途不松 ——
                    // 中途松了会漏出空窗，别的请求挤进来就会同时开两路扫描。
                    libScanDepth.decrementAndGet();
                    synchronized (libScanLock) { libScanChained = false; }
                }
            }
        }, "lib-rescan");
        t.setDaemon(true);
        t.start();
    }

    /** 串行化「检查并占用」重扫标志，避免并发起两路扫描 */
    private final Object libScanLock = new Object();

    /**
     * 片源为空时「先扫点什么」的兜底目标（2026-09-20 晚重写）。
     *
     * 🔴 **本机 strm 目录优先**。兜底的语义是「用户还没挑片源，至少先给点能看的」，
     *    而本机 strm 库（那批自动生成的 .strm）正好就是这个语义 —— 而且它走
     *    `java.io.File` 枚举（实测秒级），远好过退到 WebDAV 根目录做全树深扫
     *    （实测十分钟级，还白打一堆网盘接口）。
     *
     *    ⚠️ 这条对「换机流程」是关键的：新机冷启时片源往往还是空的（备份里的
     *       片源要等导入那一步才补上），老实现会当场起一轮扫 WebDAV 根的慢扫描 ——
     *       等它跑完新配置才生效，用户看到的就是「导入了半天没反应」。
     *
     * ⚠️ 判据是「目录里**真有** .strm」而不是「目录存在」：空目录当片源只会让首页
     *    显示「0 个视频」，那还不如照旧退到根目录去碰碰运气。
     * ⚠️ 这个返回值只当**扫描目标**用（labels）。回给前端的 `dirs` 必须仍是用户配置的
     *    那份（见 doScan 开头的 cfgDirs）—— 别再让它变成「自动加进来的片源」。
     */
    private List<String> defaultRoots() {
        List<String> out = new ArrayList<>();
        if (countStrmFiles(new File(strmLocalDir())) > 0) {
            out.add(LOCAL_PREFIX + "/");
            return out;
        }
        String d = effectiveDir();
        if (d != null && !d.isEmpty() && !d.equals("/")) out.add(d);
        else out.add("/");
        return out;
    }

    // ---------------------------------------------------------------- 点赞收藏

    private Resp handleState(String method, JSONObject body) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if ("GET".equals(method)) {
            JSONObject o = new JSONObject();
            try {
                o.put("likes", parseMap(p.getString("likes", "{}")));
                o.put("favorites", parseMap(p.getString("favorites", "{}")));
                o.put("badStreams", parseMap(p.getString("badStreams", "{}")));
            } catch (Exception ignore) {}
            return json(200, o);
        }
        // POST：body = { type: 'like'|'favorite'|'badstream', id, on }
        String type = body.optString("type", "");
        String id = body.optString("id", "");
        boolean on = body.optBoolean("on", false);
        if (!id.isEmpty() && ("like".equals(type) || "favorite".equals(type) || "badstream".equals(type))) {
            String key = "like".equals(type) ? "likes" : ("favorite".equals(type) ? "favorites" : "badStreams");
            JSONObject map = parseMap(p.getString(key, "{}"));
            try {
                if (on) map.put(id, true);
                else map.remove(id);
                p.edit().putString(key, map.toString()).apply();
            } catch (Exception ignore) {}

            // 点赞/收藏成功 → 后台把缩略图截好存起来。
            // 用户之后翻「我点赞的」列表时图已经是现成的，不用现场等；
            // 取消点赞不删图（很可能马上又点回来，重抽一次要连 NAS 读流，不划算）。
            if (on && ("like".equals(type) || "favorite".equals(type))) {
                try {
                    String streamUrl = "http://127.0.0.1:" + port + "/api/stream?p="
                            + java.net.URLEncoder.encode(id, "UTF-8");
                    thumbs.ensure(id, streamUrl);
                } catch (Throwable t) {
                    Log.w(TAG, "排缩略图任务失败 " + t.getMessage());
                }
            }
        }
        JSONObject o = new JSONObject();
        try { o.put("ok", true); } catch (Exception ignore) {}
        return json(200, o);
    }

    /**
     * POST /api/state/bulk —— 整体写回三份名单（**多设备同步专用**）。
     *
     * 为什么要单开一个接口：同步一次可能带来几百条差异，拿 `/api/state` 逐条发
     * 就是几百个请求（真机上要等十几秒）。这里一次覆盖。
     *
     * ⚠️ 语义是**整体替换**，不是合并 —— 调用方（前端）手里已经是合并后的权威结果，
     *    这边再合并一次会把刚刚删掉的条目又并回来（「取消收藏同步不过去」）。
     * ⚠️ 只认对象形状；数组/字符串一律忽略，免得把名单写成乱七八糟的东西。
     */
    private Resp handleStateBulk(JSONObject body) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        SharedPreferences.Editor ed = p.edit();
        int n = 0;
        for (String k : new String[]{"likes", "favorites", "badStreams"}) {
            JSONObject o = body.optJSONObject(k);
            if (o == null) continue;
            ed.putString(k, o.toString());
            n++;
        }
        if (n == 0) return json(400, err("三个名单一个都没带"));
        ed.apply();
        Log.i(TAG, "同步写回本机名单：" + n + " 份");
        JSONObject o = new JSONObject();
        try { o.put("ok", true); o.put("n", n); } catch (Exception ignore) {}
        return json(200, o);
    }

    // ---------------------------------------------------------------- 缩略图

    /**
     * 取缩略图。命中落盘缓存秒回；没有就现场抽一帧（同时写盘，下次就快了）。
     * 与 Node 版协议一致：GET /api/thumb?p=<相对路径>
     */
    private Resp     handleThumb(Req req, Map<String, String> q) {
        String rel = q.containsKey("p") ? q.get("p") : "";
        if (rel.isEmpty()) return json(400, err("missing p"));

        /* 🔴 本机片源（local:）要先分流：不能直接 normAbs（会变成 /local:/... 认不出前缀）。
         * ⚠️ 但**不要**在这里「因为它是本机就一律不抽帧」—— 见下面 isStrmPath 的注释
         *    （2026-09-20 修：旧写法把整条本机片源的缩略图全拦死了）。 */
        final boolean local = isLocalSrc(rel);
        String abs = local ? normSrc(rel) : NasService.normAbs(rel);

        /* .strm 不抽帧（2026-09-19）——**只针对 WebDAV 片源**：
         * 抽帧要顺着 302 打一次真实直链 —— 为了张缩略图去打网盘 API
         * 正是用户想避免的事（防风控）。
         *
         * 🔴 本机片源没有这个顾虑（2026-09-20 用户拍板「要抽，和普通视频一样」）：
         *    本机 strm 抽帧走的是 http://127.0.0.1:<port>/api/stream（**本地服务**），
         *    不是直连网盘；而且只取开头关键帧，量与「用户点开播放」同级 ——
         *    本机片源本来就是拿来播的，不差这一次。
         *    反过来说：不抽帧的话「我点赞的」列表里全是 ⚠️ 破图标。 */
        if (!local && isStrmPath(abs)) return json(502, err("strm 链接不生成缩略图"));

        File f = thumbs.fileFor(rel);
        if (f.isFile() && f.length() > 0) return fileResp(f, true);

        // 没缓存：这次请求现场生成（同步等，因为前端就等这张图显示）
        if (!rel.isEmpty()) {
            String streamUrl;
            try {
                streamUrl = "http://127.0.0.1:" + port + "/api/stream?p="
                        + java.net.URLEncoder.encode(rel, "UTF-8");
            } catch (java.io.UnsupportedEncodingException e) {
                return json(400, err("路径编码失败"));
            }
            if (genSync(rel, streamUrl)) {
                f = thumbs.fileFor(rel);
                if (f.isFile() && f.length() > 0) return fileResp(f, true);
            }
        }
        return json(502, err("缩略图生成失败"));
    }

    /** 同步生成一张（给 /api/thumb 的首次请求用），返回是否成功 */
    private boolean genSync(String rel, String streamUrl) {
        final Object done = new Object();
        final boolean[] ok = {false};
        Thread t = new Thread(() -> {
            try {
                MediaMetadataRetriever r = new MediaMetadataRetriever();
                try {
                    r.setDataSource(streamUrl, new HashMap<String, String>());
                    long durMs = 0;
                    try {
                        String d = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
                        if (d != null) durMs = Long.parseLong(d);
                    } catch (Exception ignore) {}
                    long baseUs = durMs > 0
                            ? (durMs >= 60_000L ? 60_000L : Math.max(1000L, durMs / 4)) * 1000L
                            : 60_000_000L;
                    Bitmap b = r.getFrameAtTime(baseUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
                    if (b != null) {
                        int w = b.getWidth(), h = b.getHeight();
                        int outW = Math.min(320, w);
                        int outH = Math.max(2, Math.round((float) h * outW / w));
                        if (outH % 2 != 0) outH++;
                        Bitmap s = Bitmap.createScaledBitmap(b, outW, outH, true);
                        if (s != b) b.recycle();
                        File out = thumbs.fileFor(rel);
                        File tmp = new File(thumbs.dir(), out.getName() + ".part");
                        FileOutputStream os = new FileOutputStream(tmp);
                        s.compress(Bitmap.CompressFormat.JPEG, 82, os);
                        os.close();
                        s.recycle();
                        if (!tmp.renameTo(out)) { out.delete(); tmp.renameTo(out); }
                        ok[0] = out.isFile() && out.length() > 0;
                    }
                } finally {
                    try { r.release(); } catch (Throwable ignore) {}
                }
            } catch (Throwable e) {
                Log.w(TAG, "缩略图同步生成失败 " + rel + " " + e);
            }
            synchronized (done) { done.notifyAll(); }
        }, "thumb-sync");
        t.setDaemon(true);
        t.start();
        synchronized (done) {
            try { done.wait(45_000); } catch (InterruptedException ignore) {}
        }
        return ok[0];
    }

    /**
     * 补齐缩略图：body = { items: [{p, ...}] }
     * 用来把「已点赞但我还没生成过」的老数据补上，以及 App 启动时预热。
     * 只是排进队列，立刻返回，不阻塞。
     */
    private Resp handleThumbBackfill(JSONObject body) {
        JSONArray arr = body.optJSONArray("items");
        int n = 0, skipped = 0;
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                String rel = arr.optString(i, "");
                if (rel.isEmpty()) continue;
                if (thumbs.has(rel)) { skipped++; continue; }
                /* .strm 不进抽帧队列（同 handleThumb，只针对 WebDAV 片源；
                   本机片源要抽 —— 2026-09-20） */
                if (!isLocalSrc(rel) && isStrmPath(NasService.normAbs(rel))) { skipped++; continue; }
                String streamUrl;
                try {
                    streamUrl = "http://127.0.0.1:" + port + "/api/stream?p="
                            + java.net.URLEncoder.encode(rel, "UTF-8");
                } catch (Exception e) { continue; }
                thumbs.ensure(rel, streamUrl);
                n++;
            }
        }
        long[] st = thumbs.stats();
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("queued", n);
            o.put("skipped", skipped);
            o.put("cached", st[0]);
            o.put("bytes", st[1]);
        } catch (Exception ignore) {}
        return json(200, o);
    }

    /** 缩略图落盘的统计（给「我的」页显示缓存情况） */
    private Resp handleThumbStats() {
        long[] st = thumbs.stats();
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("cached", st[0]);
            o.put("bytes", st[1]);
            o.put("dir", thumbs.dir().getAbsolutePath());
        } catch (Exception ignore) {}
        return json(200, o);
    }

    /**
     * 探测时长：GET /api/probe?p=<相对路径>
     *
     * 为什么需要它：转码流（/api/transcode）没有时间轴可跳，前端要把进度条比例
     * 换算成「目标秒数 t」再重新起一路流。没有总时长就换算不出来 —— 前端只能弹
     * 「这个文件还没读出时长，先从头看吧」，进度条基本废掉。
     *
     * 之前这里是 err("probe not implemented")，前端拿不到 duration，
     * 于是**每次拖进度条都弹那个提示**（用户反馈的问题）。
     *
     * 用 MediaMetadataRetriever（和缩略图同一套路），对着本机自己的 /api/stream 取，
     * 让本机服务代劳 WebDAV 鉴权。结果进 probeCache，第二次秒回。
     *
     * 另外还要给**画面尺寸**（width/height）—— 前端靠它把加载转圈对准视频画面矩形。
     * 转码流在 WebView 里 `videoWidth` 恒为 0（fragmented MP4 的空 moov），
     * 所以这里不给就没人能给了。
     */
    private Resp handleProbe(Map<String, String> q) {
        String rel = q.containsKey("p") ? q.get("p") : "";
        if (rel.isEmpty()) return json(200, err("路径不对"));
        String abs = NasService.normAbs(rel);
        if (!extOk(abs)) return json(200, err("路径不对"));

        Probe hit = probeCache.get(rel);
        // ⚠️ 缓存的「命中条件」不能只看时长：尺寸可能是补上去的。
        //    老缓存（这个字段还没有的年代）只有时长，那时宽高都是 0；
        //    如果只判 hit != null，就会永远返回没有尺寸的旧结果。
        //    所以这里要求「时长有效」——尺寸缺失是合法的（有些片就是拿不到），
        //    前端对此也有兜底（回退整屏居中）。
        if (hit != null && hit.dur > 0) {
            return json(200, probeJson(hit, true));
        }

        double dur = 0;
        int pw = 0, ph = 0;
        try {
            String streamUrl = "http://127.0.0.1:" + port + "/api/stream?p="
                    + java.net.URLEncoder.encode(rel, "UTF-8");
            long[] m = thumbs.probeMeta(streamUrl);
            if (m[0] > 0) dur = m[0] / 1000.0;
            pw = (int) m[1]; ph = (int) m[2];
        } catch (Throwable t) {
            Log.w(TAG, "probe 失败 " + rel + " " + t.getMessage());
        }

        // ⚠️ 读不出来就**如实说读不出来** —— 这是 Phase L 的既定行为，不要试图兜底。
        //
        //    MediaMetadataRetriever 读不了 ASF/WMV 这类容器（和播放器一个道理：
        //    系统里根本没有 ASF 的解封装器）。历史上这里有三层兜底：
        //      ① 本地内嵌 ffprobe（随内嵌 ffmpeg 一起删了）
        //      ② 远端解码服务的 ffprobe（2026-09-18 按用户要求回退了）
        //    现在两个都没有，于是这类片子返回「读不出时长」，前端据此把它标成不可播 ——
        //    这正是我们想要的结果：**宁可一开始就说不能播，也不要点进去卡半天**。
        //
        //    好消息是这类片子本来就极少，而且它们就算探出时长也照样播不了。

        if (dur <= 0) return json(200, err("读不出时长"));
        Probe v = new Probe(dur, pw, ph);
        probeCache.put(rel, v);
        return json(200, probeJson(v, false));
    }

    /** 把 Probe 组装成 /api/probe 的响应。width/height 拿不到就省掉这两项。 */
    private JSONObject probeJson(Probe pr, boolean cached) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("duration", pr.dur);
            o.put("cached", cached);
            if (pr.w > 0 && pr.h > 0) {
                o.put("width", pr.w);
                o.put("height", pr.h);
            }
        } catch (Exception ignore) {}
        return o;
    }

    /** 后缀是不是我们认的视频（和 Node 版的 ALL_EXTS 一个意思） */
    private static boolean extOk(String abs) {
        String s = abs.toLowerCase();
        for (String e : NasService.ALL_EXTS) if (s.endsWith("." + e)) return true;
        return false;
    }

    /* =====================================================================================
     *  已删除：upstreamFor / probeWithFfprobe / probeMetaWithFfprobe（2026-09-18）
     * =====================================================================================
     *  这三个方法原来都是为「本地内嵌 ffmpeg」服务的：
     *
     *   · upstreamFor(rel) —— 给 ffmpeg/ffprobe 子进程拼一个能直连的取流地址
     *     （WebDAV 直连并把 Basic 认证塞进 URL，因为命令行里没法带 Cookie）。
     *     现在本机不再起 ffmpeg/ffprobe 子进程，没有「要喂地址的外部进程」了。
     *
     *   · probeWithFfprobe / probeMetaWithFfprobe —— 调本地 ffprobe 读时长和宽高，
     *     给 MediaMetadataRetriever 读不了的 ASF/WMV/VC-1 兜底。
     *     这两个方法连同「谁来兜底」这个问题一起被删掉了：本机没有 ffprobe，
     *     远端解码服务也回退了，所以**没有兜底** —— 读不出来就如实说读不出来。
     *
     *  为什么不留着让它们指到远端：
     *    那需要一台跑着 docker 的 NAS、一套额外的凭据配置、以及用户愿意长期维护它。
     *    这版 APK 的定位就是「装上就能用、不依赖别的机器」，所以权衡已经做完了：
     *    宁可少支持几种格式（wmv/avi），也不要一条会悄悄失效的外部依赖。
     *    留着旧方法只会让人以为还有本地转码，反而误导。
     */

    /** 把本地文件当作图片响应出去 */
    private Resp fileResp(File f, boolean cache) {
        Resp r = new Resp();
        r.status = 200;
        r.headers.put("Content-Type", "image/jpeg");
        r.headers.put("Cache-Control", cache ? "public, max-age=604800" : "no-store");
        r.headers.put("Access-Control-Allow-Origin", "*");
        try {
            r.body = java.nio.file.Files.readAllBytes(f.toPath());
            r.headers.put("Content-Length", String.valueOf(r.body.length));
        } catch (Exception e) {
            return json(500, err("读缩略图失败 " + e.getMessage()));
        }
        return r;
    }

    // ---------------------------------------------------------------- 视频流

    /**
     * `/api/warm?p=<相对路径>` —— **提前把上游「热」起来**（2026-09-19 提速）。
     *
     * 为什么存在：冷启动播第一条片，最慢的不是本地代理也不是 WebView，
     * 而是上游那一段 —— CD2 引擎收到请求后要先向 115 申请下载直链再建立取流，
     * 首字节常常要 1~3 秒。这段耗时原本**串行**在「WebView 启动完 → 拿到片库 →
     * video 元素发起请求」之后；有了这个接口，前端在 WebView 还没启动完时就能
     * 用「上次播放的那条」先打一发，把 115 取流初始化跟整个启动流程**并行**掉。
     *
     * 做法：立即返回 200，后台线程对上游发一个 `Range: bytes=0-1MB` 的 GET
     * 并把数据读掉（不缓存 —— 缓存属于 CD2 的事，我们只负责把它的缓存喂热、
     * 顺带把 TCP/TLS 连接建好留给 HttpURLConnection 的 keep-alive 池复用）。
     *
     * ⚠️ 幂等：同一路径已在预热中就不再开第二个线程（warmInFlight）；
     *    预热失败完全无害 —— 真正播放时走的是 /api/stream 那套带重试的逻辑。
     */
    private Resp handleWarm(Map<String, String> q) {
        String rel = q.containsKey("p") ? q.get("p") : "";
        if (rel.isEmpty() || !isConfigured()) return json(200, err("nothing to warm"));
        /* 本机片源（local:）：预热的本意是「把 CD2 的上游缓存喂热」——
           而本机的 .strm 只是个几十字节的文本，读它不走 CD2，**没有可预热的东西**。
           直接安静返回（千万别 normAbs 之后接着往下走：那会拿 local:/x 去 dav.absUrl
           拼出一个不存在的 URL，白打一次 404）。 */
        if (isLocalSrc(rel)) return json(200, err("nothing to warm"));
        String abs = NasService.normAbs(rel);
        if (abs.equals(urlPath())) return json(200, err("这是个目录"));

        /* .strm（2026-09-19）：预热前先解析出真目标 ——
         *   · 指向本机 dav 的 URL / / 路径 → 换成那条路径照常预热（走 dav + Basic auth）；
         *   · 外部直链 → 直接对直链预热（不带本机凭据）；
         *   · 解析失败 / 内容不认 → 无事可做，安静返回。
         * 顺带 resolveStrm 会把 strm 内容读一遍并进缓存，首次播放少一次上游往返。 */
        String warmUrl = dav.absUrl(abs);
        boolean warmAuth = true;
        if (isStrmPath(abs)) {
            String target = resolveStrm(abs);
            if (target == null) return json(200, err("nothing to warm"));
            if (target.startsWith("http://") || target.startsWith("https://")) {
                String dp = localDavPathOf(target);
                if (dp != null) warmUrl = dav.absUrl(dp);
                else { warmUrl = target; warmAuth = false; }
            } else if (target.startsWith("/") && !isStrmPath(target)) {
                warmUrl = dav.absUrl(NasService.normAbs(target));
            } else {
                return json(200, err("nothing to warm"));
            }
        }
        final String fUrl = warmUrl;
        final boolean fAuth = warmAuth;
        if (!warmInFlight.add(abs)) return json(200, err("already warming"));
        Thread t = new Thread(() -> {
            java.net.HttpURLConnection up = null;
            try {
                up = (java.net.HttpURLConnection) new java.net.URL(fUrl).openConnection();
                up.setConnectTimeout(8000);
                up.setReadTimeout(15000);
                up.setRequestProperty("User-Agent", "douyin-nas-android");
                up.setRequestProperty("Range", "bytes=0-1048575");   // 只拉头 1MB，够引擎建流
                if (fAuth && user != null && !user.isEmpty()) {
                    String auth = "Basic " + android.util.Base64.encodeToString(
                            (user + ":" + pass).getBytes(java.nio.charset.StandardCharsets.UTF_8),
                            android.util.Base64.NO_WRAP);
                    up.setRequestProperty("Authorization", auth);
                }
                int code = up.getResponseCode();
                java.io.InputStream is = code >= 400 ? up.getErrorStream() : up.getInputStream();
                long total = 0;
                if (is != null) {
                    byte[] buf = new byte[65536];
                    int n;
                    while (total < 1048576 && (n = is.read(buf)) > 0) total += n;
                    is.close();
                }
                Log.i(TAG, "预热 " + abs + " 完成 HTTP " + code + " " + total + "B");
            } catch (Throwable t2) {
                Log.w(TAG, "预热失败 " + abs + " " + t2.getMessage());
            } finally {
                if (up != null) try { up.disconnect(); } catch (Throwable ignore) {}
                warmInFlight.remove(abs);
            }
        }, "cd2-warm");
        t.setDaemon(true);
        t.start();
        JSONObject o = new JSONObject();
        try { o.put("ok", true); } catch (Exception ignore) {}
        return json(200, o);
    }

    private Resp handleStream(Req req, Map<String, String> q) {
        String rel = q.containsKey("p") ? q.get("p") : "";
        if (rel.isEmpty()) return json(400, err("missing p"));

        /* ---- 本机片源（local:）(2026-09-20) ----
         * 🔴 必须在 normAbs **之前**分流：`normSrc` 才是两种形态都认的那个归一
         *    （直接 normAbs 会把 `local:/x` 补成 `/local:/x`，前缀失效 → 下面那条
         *    「这是目录」的判断会把它当 WebDAV 路径，最终疯狂打 404）。
         * 本机文件单独走一条：读磁盘上的 .strm 文本 → 解析目标 → 复用既有的
         * 「302 或内部代理」两路（那部分逻辑与 WebDAV 侧的 strm 完全共用）。 */
        if (isLocalSrc(rel)) {
            String abs0 = normSrc(rel);
            String disk = localAbs(abs0);
            if (disk == null) return json(400, err("本机片源路径不合法"));
            java.io.File f = new java.io.File(disk);
            if (!f.isFile()) return json(404, err("本机文件不存在：" + abs0));
            String target = resolveStrmFile(f);
            if (target == null) return json(502, err("strm 文件读不到，或内容为空"));
            return playStrmTarget(target, req);
        }

        String abs = NasService.normAbs(rel);

        // ⚠️ 指向「服务根」的播放请求要挡住。CD2 的 `/dav/` 会回 301，
        // 而 Location 只带路径、不带主机名，HttpURLConnection 跟着跳会拼错地址，
        // 最后报一个跟真实原因毫无关系的错。这本来也不是视频，直接说清楚。
        // （app.js 那边点目录不会走播放接口，属于各守一道。）
        if (abs.equals(urlPath())) return json(400, err("这是个目录，不是视频"));

        if (!isConfigured()) return json(400, err("未配置 WebDAV"));

        /* ---- .strm 链接文件（2026-09-19，用户要求「扫描播放 strm」）----
         * strm 内容是一行目标：http(s) 直链，或 / 开头的 WebDAV 路径。
         *   · 直链        → 302 把 WebView / 原生播放器直接引过去（不经本机代理，
         *                    播放流量不占手机中转，也不再多打一次 115 列目录 API）；
         *   · 本机 CD2 dav URL（127.0.0.1:19798/dav/...）→ 不能 302：CD2 的 dav
         *                    强制 Basic 认证，播放器跟过去只会吃 401 —— 换成路径
         *                    走内部代理，凭据由 streamUpstream 补上；
         *   · / 开头路径  → 内部代理（跟普通视频同一条拉流路）。
         * 前端**一行都不用改**：streamUrl() 照旧给 /api/stream?p=<strm 路径>，
         * WebView <video> 和 ExoPlayer 都会自动跟随 302（同协议重定向）。
         *
         * ⚠️ 「解析出目标之后怎么播」那一段现在归 playStrmTarget() —— 上面的
         *    本机片源分支（local:）也走它，两边**必须**是同一条路。 */
        if (isStrmPath(abs)) {
            return playStrmTarget(resolveStrm(abs), req);
        }

        return streamUpstream(abs, req);
    }

    /** 路径是不是 .strm 链接文件 */
    private static boolean isStrmPath(String abs) {
        return "strm".equals(NasService.extOf(abs == null ? "" : abs));
    }

    /**
     * 读一个 .strm 文件，返回解析出的目标（http(s) URL 或 / 开头的 WebDAV 路径）。
     * 读不到 / 内容为空返回 null。
     *
     * ⚠️ 结果缓存进 strmCache：strm 只有几十字节，可每次播放都上游 GET 一遍
     *    就是白给 115 送 API 调用（用户加 strm 正是为了**少**打 115，防风控）。
     *    缓存挂在 App 进程生命周期上，片源重扫时清空（strmCacheClear）。
     */
    private String resolveStrm(String abs) {
        String hit = strmCache.get(abs);
        if (hit != null) return hit;
        java.net.HttpURLConnection up = null;
        try {
            up = (java.net.HttpURLConnection) new java.net.URL(dav.absUrl(abs)).openConnection();
            up.setConnectTimeout(8000);
            up.setReadTimeout(15000);
            up.setRequestProperty("User-Agent", "douyin-nas-android");
            if (user != null && !user.isEmpty()) {
                String auth = "Basic " + android.util.Base64.encodeToString(
                        (user + ":" + pass).getBytes(java.nio.charset.StandardCharsets.UTF_8),
                        android.util.Base64.NO_WRAP);
                up.setRequestProperty("Authorization", auth);
            }
            int code = up.getResponseCode();
            if (code >= 400) return null;
            java.io.InputStream is = up.getInputStream();
            String text = is == null ? "" : readShort(is, 65536);
            String target = parseStrmText(text);        // 取第一个非空行（容忍 BOM），共用
            if (target == null) return null;
            if (strmCache.size() > 512) strmCache.clear();             // 防呆上限，正常用量到不了
            strmCache.put(abs, target);
            Log.i(TAG, "strm 解析 " + abs + " -> " + target);
            return target;
        } catch (Exception e) {
            Log.w(TAG, "读 strm 失败 " + abs + " " + e.getMessage());
            return null;
        } finally {
            if (up != null) try { up.disconnect(); } catch (Throwable ignore) {}
        }
    }

    /** 片源重扫后清 strm 解析缓存（目录结构可能变了，旧目标不可信） */
    private void strmCacheClear() {
        if (!strmCache.isEmpty()) {
            strmCache.clear();
            Log.i(TAG, "strm 缓存已清空（片源重扫）");
        }
    }

    /**
     * 从一段 strm 文本里取目标（第一个非空行）。空 → null。
     *
     * 🔴 抽出来共用：本机上那份 strm 与 WebDAV 上那份**内容语义完全一样**
     *    （都是一行「http(s) 直链」或「/ 开头的 WebDAV 路径」），
     *    解析规则必须只有一份，否则改了一边另一边会静默不一致。
     *    容忍 BOM —— Windows 上记事本另存为 UTF-8 会带上，用户手改过 strm 很常见。
     */
    private static String parseStrmText(String text) {
        if (text == null) return null;
        if (text.startsWith("\uFEFF")) text = text.substring(1);
        for (String line : text.split("\r?\n")) {
            String t = line.trim();
            if (!t.isEmpty()) return t;
        }
        return null;
    }

    /**
     * 读**本机**的一个 .strm 文件，返回解析出的目标（2026-09-20 本机片源新增）。
     *
     * 与 resolveStrm 同一套缓存（strmCache）—— 键用绝对磁盘路径，
     * 与 WebDAV 侧的 `local:...` 片源坐标不会撞车（那边键是 `/dav/...`）。
     */
    private String resolveStrmFile(java.io.File f) {
        String key = "file:" + f.getAbsolutePath();
        String hit = strmCache.get(key);
        if (hit != null) return hit;
        try {
            String text = readShort(new java.io.FileInputStream(f), 65536);
            String target = parseStrmText(text);
            if (target == null) return null;
            if (strmCache.size() > 512) strmCache.clear();
            strmCache.put(key, target);
            Log.i(TAG, "本机 strm 解析 " + f.getName() + " -> " + target);
            return target;
        } catch (Exception e) {
            Log.w(TAG, "读本机 strm 失败 " + f.getAbsolutePath() + " " + e.getMessage());
            return null;
        }
    }

    /**
     * 把「strm 解析出来的目标」变成一次播放响应 —— 302 或内部代理。
     *
     * 🔴 抽出来共用（2026-09-20）：本机 strm 和 WebDAV strm 解析出目标之后，
     *    **后续该怎么播是一模一样的**，这段判断绝不能写两份。
     *
     *   · http(s) 直链        → 若它其实指向本机 CD2 的 dav（127.0.0.1:19798/dav/…）
     *                          则**不能** 302：CD2 的 dav 强制 Basic 认证，
     *                          播放器跟过去只会吃 401 → 换成内部代理补凭据；
     *                          真正的外网直链才 302（不经手机中转，省流量）。
     *   · `/` 开头的 WebDAV 路径 → 内部代理（跟普通视频同一条拉流路）。
     *
     * @param req 用于内部代理（要转发 Range 等请求头）
     */
    private Resp playStrmTarget(String target, Req req) {
        if (target == null) return json(502, err("strm 文件读不到，或内容为空"));
        if (target.startsWith("http://") || target.startsWith("https://")) {
            String davPath = localDavPathOf(target);
            if (davPath != null) {
                if (isStrmPath(davPath)) return json(400, err("strm 又指向了另一个 strm，不支持"));
                return streamUpstream(davPath, req);
            }
            return seeOther(target);
        }
        if (target.startsWith("/")) {
            if (isStrmPath(target)) return json(400, err("strm 又指向了另一个 strm，不支持"));
            return streamUpstream(target, req);
        }
        return json(400, err("strm 内容不是 http(s) 链接，也不是 / 开头的路径"));
    }

    // ---------------------------------------------------------------- strm 自动库（2026-09-20）

    /**
     * 按当前配置重排定时任务（start 与配置 POST 都会调；内部幂等）。
     *
     * 冷启动补偿：App 不是常驻进程 —— 用户一天开几次，如果简单地「隔一个周期跑第一轮」，
     * 24h 档可能永远赶不上 App 开着的那一刻。所以上次运行距今已超过一个周期时，
     * 第一轮立刻补跑（delay=0）。
     */
    private synchronized void strmSchedule() {
        if (strmTimer != null) { strmTimer.cancel(false); strmTimer = null; }
        int h = strmIntervalH;
        // 🔴 输出位置已经固定（App 内目录，永远存在）→ 这里只剩「勾了监控目录」这一个前提。
        //    别再判 strmOut/strmLocal —— 那两个字段都没了（见字段头上 A 段）。
        if (h <= 0 || strmJobs.isEmpty()) return;   // 仅手动 / 没勾任何目录
        long periodMs = h * 3600_000L;
        long delayMs = periodMs;
        if (strmLastRun > 0 && System.currentTimeMillis() - strmLastRun >= periodMs) delayMs = 0;
        /* fixedDelay 而不是 fixedRate：一轮可能跑十分钟以上，按「上轮结束」起算
           才不会把轮次背靠背堆起来（另有 strmRunning 防重入双保险）。 */
        strmTimer = strmSched.scheduleWithFixedDelay(this::strmRunAsync, delayMs, periodMs,
                java.util.concurrent.TimeUnit.MILLISECONDS);
        Log.i(TAG, "strm 定时任务已排：每 " + h + " 小时"
                + (delayMs == 0 ? "（上次运行已过期，立即补跑一轮）" : ""));
    }

    /**
     * 异步触发一轮 strm 生成（定时 / 手动都走这里）。
     * 返回是否真的起了线程（已在跑 = false，调用方回 already-running）。
     */
    private boolean strmRunAsync() {
        if (!strmRunning.compareAndSet(false, true)) {
            Log.i(TAG, "strm 生成已在跑，跳过本轮触发");
            return false;
        }
        Thread t = new Thread(this::strmJob, "strm-run");
        t.setDaemon(true);
        t.start();
        return true;
    }

    /**
     * 一轮 strm 生成（跑在 strm-run 线程）：
     *
     *   阶段一：对每个监控目录跑 NasService.scan（与片库同一套并发 BFS，上限同源）；
     *   阶段二：对每个视频算落点 `<固定目录>/<监控目录名>/<目录内相对路径>.strm`，
     *           对照 manifest（视频路径 → 落点）—— 落点没变 → 跳过（增量）；变了/没有 → 写盘记账。
     *
     * 两阶段而不是扫一个写一个：total 一开始就定，前端进度条才有分母。
     *
     * 🔴 2026-09-20 二次改版：**只剩本地这一路**（用户拍板「回传不要了」）。
     *    原来是「本地 + PUT 回传 NAS」两路，现在输出位置固定成 App 内目录，
     *    没有第二路可选 —— 所以代码里再没有 strmOut / MKCOL / PUT / 300ms 节流。
     *    ⚠️ 别再让「两路」的写法回来。特别地：PUT 那路当年逼着要 300ms 节流防 115 限流，
     *      纯本地写**不需要**节流 —— 一个都不留，扫完就写完。
     *
     * ⚠️ manifest **不删旧条目**：视频被删/目录扫挂时旧条目留着 ——
     *    网络抖动恢复后仍能增量跳过，代价只是 manifest 慢慢变大（每条约 100B，万级视频 ~1MB）。
     *    监控目录改名会导致落点变化 → 自动全量重写，无需额外失效逻辑。
     *
     * 体积阈值（2026-09-22，用户要求「小于设定大小跳过生成」）：`strmMinSizeMB > 0` 时，
     * 源视频体积小于它的一律不生成；并且会把**上一轮已生成的**那个 .strm 一并删掉，
     * 让这个设置立刻生效（否则用户调大阈值后点「立即生成」什么都没变，只会当成 bug）。
     */
    private void strmJob() {
        long t0 = System.currentTimeMillis();
        strmAdded = 0; strmSkipped = 0; strmFailed = 0; strmDone = 0; strmTotal = 0; strmTooSmall = 0;
        strmLastError = "";
        Log.i(TAG, "strm 生成开始");
        try {
            DavClient d = dav;              // 快照：中途配置热更 rebuildDav 换对象，本轮认准这一个
            String local = strmLocalDir();  // 固定输出目录（App 内，见 strmLocalDir）
            List<String> jobs = new ArrayList<>(strmJobs);
            if (d == null) { strmLastError = "未配置 WebDAV"; return; }
            if (jobs.isEmpty()) { strmLastError = "还没勾选要监控的文件夹"; return; }

            // ---- 阶段一：扫出所有监控目录的视频 ----
            List<NasService.Video> all = new ArrayList<>();
            final boolean[] trunc = new boolean[1];
            String firstErr = null;
            for (String root : jobs) {
                try {
                    List<NasService.Video> list = NasService.scan(d, root, recursive, maxDepth, trunc);
                    Log.i(TAG, "strm 扫描 " + root + " → " + list.size() + " 个视频");
                    all.addAll(list);
                } catch (Exception e) {
                    Log.w(TAG, "strm 扫描失败 " + root + " " + e.getMessage());
                    if (firstErr == null) firstErr = e.getMessage();
                    /* 与片库扫描同一套防限流：内置网盘的登录锁是「越撞越久」，
                       认证/限流类错误立刻放弃整轮，别试下一个目录再撞一遍。 */
                    if (isAuthOrLimitError(e.getMessage())) {
                        strmLastError = "认证/限流错误，本轮放弃：" + e.getMessage();
                        return;
                    }
                }
            }
            if (all.isEmpty() && firstErr != null) {
                strmLastError = firstErr;
                return;
            }
            strmTotal = all.size();

            // ---- 阶段二：增量判断 + 写本地 ----
            JSONObject manifest = strmManifestLoad();
            for (NasService.Video v : all) {
                strmDone++;
                String p = v.p;
                // 落点归属：取**最深**的匹配监控目录（两个监控目录嵌套时归里面那个）
                String root = null;
                for (String r : jobs) {
                    if (p.equals(r) || p.startsWith(r + "/")) {
                        if (root == null || r.length() > root.length()) root = r;
                    }
                }
                if (root == null) continue;               // 理论到不了（scan 就从这些 root 出发）
                String rel = p.substring(root.length());  // 形如 "/sub/名字.mp4"
                String srcName = NasService.baseNameOf(root);
                if (srcName.isEmpty()) srcName = "_root"; // 监控整个挂载根时的兜底名
                // 落点结构：<固定目录>/<监控目录名>/<目录内相对路径>.strm
                /* 🔴 必须过 safeStrmPath()（2026-09-20）：Android/FUSE 的**单个文件名**
                   上限是 255 **字节**，而中文/日文一个字占 3 字节 —— 一百来个字的
                   日系标题轻松爆到 300+ 字节，mkdirs 直接失败 ⇒ 前端只看到一句
                   「写入失败」，看不出为什么（实测 5255 个里 16 个因此失败）。
                   安全化后落点变了，manifest 里那份旧签名对不上 ⇒ 这 16 个会在
                   下一轮重写（正是我们要的，这次就能写进去了）。 */
                String localPath = safeStrmPath(local + "/" + srcName + rel + ".strm");

                /* ---- 体积阈值（2026-09-22 用户要求「小于设定大小跳过生成」）----
                 *
                 * 判据用**源视频的体积**（v.size 来自 PROPFIND 的 getcontentlength），
                 * **不是** .strm 文件自身的大小 —— 那个只有几十字节，拿它比会全军覆没。
                 *
                 * 🔴 光「不生成」不够：用户库里往往**已经**有一批旧 .strm 了，
                 *    阈值调大之后那些小文件必须跟着消失，否则这个设置等于没生效
                 *    （用户点「立即生成」却什么都没变，只会当成 bug 报回来）。
                 *    所以这里顺带清掉**上一轮由我们自己写在 manifest 里的**那一个落点：
                 *      · 只删 manifest 记过的（没记过的不是我们生成的，绝不动）；
                 *      · 且必须落在本机 strm 目录 `local/` 里（双保险，防 manifest 被写脏）。
                 *
                 * ⚠️ `v.size > 0` 才判：拿不到体积时**放行**（跟「屏蔽小文件」同一条原则 ——
                 *    证明不了小，就不许丢）。 */
                if (strmMinSizeMB > 0 && v.size > 0 && v.size < strmMinSizeMB * 1024L * 1024L) {
                    strmTooSmall++;
                    String old = manifest.optString(p, "");
                    if (!old.isEmpty()) {
                        if (old.startsWith(local + "/")) {
                            try { new java.io.File(old).delete(); } catch (Throwable ignore) {}
                        }
                        manifest.remove(p);          // 落点没了，索引也得跟着删，否则永远不再重算
                        strmRev++;                   // 库真的变了（少了一条）→ 备份该重传
                    }
                    continue;
                }

                /* 增量签名 = 落点本身。落点变了（监控目录改名 / 固定目录换位置）就重写。
                   ⚠️ 旧版 manifest 存的是「两路落点拼起来」的串 —— 那些值对不上现在这个签名，
                      于是升级后**首轮会全量重写一遍**。这是幂等的（同内容覆盖），
                      而且固定目录里那份本来就要重建，无害。 */
                String sig = localPath;
                if (manifest.optString(p, "").equals(sig)) {
                    strmSkipped++;                        // 增量命中：落点没变 = 内容没变，不重写
                    continue;
                }

                // 内容与 _tools/make-strm.js 完全一致：BOM + dav 绝对路径 + 换行
                byte[] body = ("\uFEFF" + p + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);

                /* strmWriteLocal 返回 null = 成功，否则返回**失败原因**。
                   🔴 光报「写入失败」不够 —— 2026-09-20 就是靠把原因带出来才查清
                      是文件名超长（255 字节），不然只有一句「写入失败」没法定位。 */
                String werr = strmWriteLocal(localPath, body);
                if (werr == null) {
                    /* JSONObject.put 是受检异常 —— 外层 try-finally 没有 catch，
                       不当场吞掉的话 javac 直接编译失败（build 抓到过） */
                    try { manifest.put(p, sig); } catch (Exception ignore) {}
                    strmAdded++;
                    strmRev++;                    // 真写了一个文件 → 库变了，备份该重传
                } else {
                    strmFailed++;
                    if (strmLastError.isEmpty()) {
                        strmLastError = "写入失败 " + localPath + "（" + werr + "）";
                    }
                    /* 故意不记 manifest：下轮重试才有机会补上 */
                }
            }
            strmManifestSave(manifest);
            /* 生成成功 → 把本机 strm 目录**自动加进片源**（2026-09-20 用户拍板）。
               否则用户拿到一堆 .strm 却没有任何入口能看到它们 —— 这正是
               「生成的 strm 怎么播放」那个问题的真身：文件生成了、播放逻辑也有，
               但片库里根本刷不到。加了片源后回首页就能看到、点开就播。 */
            if (strmAdded > 0 || strmSkipped > 0) strmRegisterLocalSrc();
            Log.i(TAG, "strm 生成完成：新增 " + strmAdded + " / 跳过 " + strmSkipped
                    + " / 太小 " + strmTooSmall + "（阈值 " + strmMinSizeMB + "MB）"
                    + " / 失败 " + strmFailed + " / 共 " + strmTotal
                    + "，耗时 " + (System.currentTimeMillis() - t0) / 1000 + " 秒");
        } finally {
            /* 🔴 防重入标志**必须**在这里释放 —— 漏了它的话第一轮跑完后
             *    CAS 的 true 永远占着坑，后续手动触发和定时任务全部
             *    「已在跑，跳过」，功能静默失效（2026-09-20 端到端验证抓到）。 */
            strmRunning.set(false);
            strmLastRun = System.currentTimeMillis();
            strmTouchLastRun();
            /* 库版本号也在这里落盘（同 strmTouchLastRun 的理由：不是配置变更）。
               前端就是靠它判断「这轮有没有真的改动过」→ 变了才自动重传备份。 */
            strmTouchRev();
        }
    }

    /**
     * 🔴 strm 输出的**固定目录**（2026-09-20 起用户不用再填任何路径）。
     *
     * `getExternalFilesDir(null)/strm` =
     *   `/sdcard/Android/data/com.nas.douyin/files/strm`
     *
     * 为什么用这个而不是公共存储（Download/…）：
     *   · **免授权** —— 它是 App 自己的外部目录，写上就通，不需要
     *     MANAGE_EXTERNAL_STORAGE（那玩意儿要跳系统设置页，是这条功能里最烦的一步）；
     *   · 不需要「所有文件访问」权限探测（strmLocalPermOk / permOk 已随之删除）。
     * 代价：部分文件管理器在 `Android/data/` 下看不到它 —— 但用数据线接电脑、
     * 或用支持访问该目录的文件管理器仍能拿到；且卸载 App 时一并清理。
     *
     * ⚠️ getExternalFilesDir 可能返回 null（外部存储没挂载，罕见）→ 退到内建的 filesDir，
     *    写进去照样能用，只是更不显眼，总比崩掉强。
     */
    private String strmLocalDir() {
        try {
            java.io.File f = ctx.getExternalFilesDir(null);
            if (f != null) return new java.io.File(f, "strm").getAbsolutePath();
        } catch (Throwable ignore) {}
        return new java.io.File(ctx.getFilesDir(), "strm").getAbsolutePath();
    }

    /*
     * =====================================================================================
     *  已删除：strmMkdirs()（2026-09-20 二次改版）
     * =====================================================================================
     *  它原来为「PUT 回传 NAS」那一路逐级 MKCOL 建父目录（405=已存在忽略）。
     *  用户拍板「回传不要了」之后，那一路整个消失 —— 它就成了**只被死代码引用**的函数。
     *  ⚠️ 别把它加回来：要向 NAS 写 strm 就得连 MKCOL 链 + 300ms 节流一起恢复，
     *     而那是用户明确否掉的方案（见字段头上 A 段）。
     */

    /**
     * 把「本机 strm 目录」加进片源（幂等；2026-09-20 用户拍板「自动加、不给删」）。
     *
     * 用 `local:/` 这个片源坐标（= strm 根目录本身），见 LOCAL_PREFIX。
     *
     * 🔴 为什么是 `local:/` 而不是 `local:/云下载`（按监控目录逐个加）：
     *    · 一个监控目录一条片源，用户改清单时片源栏会跟着长长短短，很容易变成
     *      「删了监控项但片源还在」的困惑；
     *    · 只加根一条，strm 目录里的所有子目录**天然被递归扫到**，
     *      清单怎么变都不用动片源 —— 少一处需要同步的状态。
     *
     * ⚠️ persistConfig() 必须调：否则重启后片源又没了（配置没落盘）。
     * ⚠️ 故意**不**动 libCache / libSig：这里只是加了一条片源，
     *    由调用方（strm 任务）之后自己决定要不要重扫；在这里偷偷作废缓存
     *    会让首页在没有任何用户操作的情况下突然闪白。
     */
    private synchronized void strmRegisterLocalSrc() {
        String src = LOCAL_PREFIX + "/";
        if (dirs.contains(src)) return;
        /* 目录还不存在（一条都没生成成功过）就别加，免得片源栏挂一条永远空的 */
        java.io.File root = new java.io.File(strmLocalDir());
        if (!root.isDirectory()) return;
        dirs.add(src);
        persistConfig();
        Log.i(TAG, "已把本机 strm 目录加进片源：" + src);
        localSrcJustAdded.set(true);
    }

    /**
     * strm 根目录下到底有没有 .strm（**只看有没有，不数完**）。
     *
     * 用途只有一个：strm 备份导入完之后判断「要不要把本机片源补回去」（见 strmBackupRead）。
     * 那儿是 5000+ 个文件的小文件树，全树走一遍纯属浪费 —— 命中一个就返回。
     */
    private static int countStrmFiles(File dir) {
        File[] fs = dir.listFiles();
        if (fs == null) return 0;
        for (File f : fs) {
            if (f.isDirectory()) {
                if (countStrmFiles(f) > 0) return 1;
            } else if (f.getName().endsWith(".strm")) {
                return 1;
            }
        }
        return 0;
    }

    /**
     * POST /api/strm/clear —— **清空本机 strm 库**（2026-09-22 用户要求）。
     *
     * 只删本机这个固定目录（strmLocalDir）里的 .strm + 增量索引；
     * **账号里的备份包一个字节都不动** —— 那是别的设备换机恢复用的，本按钮不该碰它。
     *
     * ⚠️ 前端那句提示必须说清「登录着同步账号的话，下次同步会再拉回来」：
     *    只清本机、不动云端，效果就是「删了 → 同步又恢复」，用户会当成 bug 报回来。
     *    想彻底清除，得配合「删除云端备份」那个按钮一起用（两者各司其职）。
     */
    private Resp handleStrmClear(String method) {
        if (!"POST".equals(method)) return json(405, err("use POST"));
        int files = deleteStrmTree(new File(strmLocalDir()), true);
        /* 🔴 索引必须一起清：留着的话下一轮生成会以为「全都写过了」→ 全部 skipped，
           文件一个都回来（用户看到的就是「清空之后再也生成不出来了」）。 */
        try {
            File mf = strmManifestFile();
            if (mf.isFile()) mf.delete();
        } catch (Throwable ignore) {}
        /* 库变了（少了 N 个）→ 版本号 +1。前端靠它判断「要不要重传备份」。 */
        strmRev++;
        strmTouchRev();
        /* 本机片源里那条 `local:/` 也摘掉：目录都空了，留着它片源栏会显示一个 0 视频的源。
           ⚠️ 同步可能会把它加回来（账号的片源清单里还有）—— 那是另一回事，
              这里只负责让**本机此刻**的状态自洽。 */
        boolean srcRemoved = dirs.remove(LOCAL_PREFIX + "/");
        if (srcRemoved) {
            if (dir != null && (LOCAL_PREFIX + "/").equals(dir)) dir = dirs.isEmpty() ? "" : dirs.get(0);
            persistConfig();
        }
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("files", files);
            o.put("srcRemoved", srcRemoved);
            o.put("rev", strmRev);
        } catch (Exception ignore) {}
        Log.i(TAG, "清空本机 strm 库：删除 " + files + " 个文件");
        return json(200, o);
    }

    /**
     * 递归删掉 dir 下所有 .strm，空掉的**子目录**顺手清掉（isRoot 那个留着 ——
     * 它是固定目录，别的逻辑会假设它存在）。返回删除的文件数。
     */
    private static int deleteStrmTree(File dir, boolean isRoot) {
        File[] fs = dir.listFiles();
        if (fs == null) return 0;
        int n = 0;
        for (File f : fs) {
            if (f.isDirectory()) n += deleteStrmTree(f, false);
            else if (f.getName().endsWith(".strm")) {
                try { if (f.delete()) n++; } catch (Throwable ignore) {}
            }
        }
        if (!isRoot) {
            try { dir.delete(); } catch (Throwable ignore) {}     // 只有空目录才删得掉
        }
        return n;
    }

    /**
     * 本地写一个 strm 文件：父目录自动 mkdirs，成功 true。
     *
     * 🔴 写的是 App 自己的外部目录（getExternalFilesDir，见 strmLocalDir）——
     *    **不需要任何存储权限**，所以这里没有任何权限检查。
     *    （旧版写公共存储时要「所有文件访问」，那个探测 strmLocalPermOk 已随本次改版删除。）
     * 注意 mkdirs() 返回 false 有两种含义：目录本来就在（isDirectory 能查出来）或真失败。
     */
    /** 返回 null = 成功；否则返回**失败原因**（给前端显示，别只说「写入失败」） */
    private String strmWriteLocal(String localPath, byte[] body) {
        try {
            java.io.File f = new java.io.File(localPath);
            java.io.File pf = f.getParentFile();
            if (pf != null && !pf.isDirectory() && !pf.mkdirs() && !pf.isDirectory()) {
                Log.w(TAG, "strm 本地建目录失败 " + pf);
                return "建目录失败";
            }
            java.io.FileOutputStream fo = new java.io.FileOutputStream(f);
            fo.write(body);
            fo.close();
            Log.i(TAG, "strm 本地生成 " + localPath);
            return null;
        } catch (Exception e) {
            String m = e.getMessage();
            if (m == null || m.isEmpty()) m = e.getClass().getSimpleName();
            Log.w(TAG, "strm 本地写入失败 " + localPath + " " + m);
            return m;
        }
    }

    /* ============================================================
       路径安全化：把 Android/FUSE 的「单文件名 255 字节」硬上限挡住
       ------------------------------------------------------------
       2026-09-20 实测：5255 个 .strm 里 16 个「写入失败」，查出来全是
       **目录名太长** —— 设备上限量过：250✅ 255✅ 256❌ 300❌，
       而那些日系标题 117 个字符 / 311 **字节**（中日文 3 字节一个字）。
       mkdirs 失败 ⇒ strmWriteLocal 返回 false ⇒ 前端只有一句「写入失败」，
       看不出是长度问题（日志里有，但用户看不到）。

       ⚠️ 三条必须同时满足，少一条就埋新雷：
         ① 按**字节**截，不是按字符 —— 按字符截中文照样超限；
         ② **不切断多字节字符** —— 否则截出半个字节序列，文件名变乱码；
         ③ **纯函数**（同输入必同输出）—— 否则增量 manifest 的签名每轮都变，
            会退化成每轮全量重写。
       ============================================================ */
    /** 单段上限（字节）。255 是硬上限，留 15 字节给哈希后缀和余量 */
    private static final int SAFE_SEG = 240;

    /** 把路径里**每一段**都压到 SAFE_SEG 字节以内（不超限的段原样不动） */
    private static String safeStrmPath(String path) {
        if (path == null || path.isEmpty()) return path;
        boolean abs = path.startsWith("/");
        StringBuilder sb = new StringBuilder();
        for (String s : path.split("/")) {
            if (s.isEmpty()) continue;
            sb.append('/').append(safeSeg(s));
        }
        String r = sb.toString();
        return abs ? r : (r.startsWith("/") ? r.substring(1) : r);
    }

    /** 单段安全化：不超限原样返回；超限截成「正文_哈希8位 + 扩展名」 */
    private static String safeSeg(String seg) {
        byte[] b = seg.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (b.length <= SAFE_SEG) return seg;
        /* 先摘出扩展名（只认最后一段「点+不超过8字符」，避免把目录名里的点当扩展名） */
        String ext = "";
        String stem = seg;
        int dot = seg.lastIndexOf('.');
        if (dot > 0 && seg.length() - dot <= 8) {
            ext = seg.substring(dot);
            stem = seg.substring(0, dot);
        }
        String hash = shortHash(seg);
        int budget = SAFE_SEG - ext.getBytes(java.nio.charset.StandardCharsets.UTF_8).length
                - hash.length() - 1;                 // -1 是中间那个下划线
        return utf8Trunc(stem, Math.max(budget, 16)) + "_" + hash + ext;
    }

    /** 按 UTF-8 字节截断，且**不切断多字节字符**（退到字符边界再停） */
    private static String utf8Trunc(String s, int maxBytes) {
        if (maxBytes <= 0) return "";
        byte[] b = s.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (b.length <= maxBytes) return s;
        int end = maxBytes;
        while (end > 0 && (b[end] & 0xC0) == 0x80) end--;   // 0x80=10xxxxxx 续字节
        return new String(b, 0, end, java.nio.charset.StandardCharsets.UTF_8);
    }

    /** 8 位十六进制短哈希（只用来防「截断后撞名」，不涉及安全） */
    private static String shortHash(String s) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("MD5");
            byte[] d = md.digest(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder h = new StringBuilder();
            for (int i = 0; i < 4 && i < d.length; i++) {
                h.append(String.format("%02x", d[i] & 0xff));
            }
            return h.toString();
        } catch (Exception e) {
            return String.format("%08x", s.hashCode());   // MD5 拿不到时的兜底
        }
    }

    /** 把「最近一轮完成时间」单独落盘（不走 persistConfig —— 配置没变，只是任务跑完了） */
    private void strmTouchLastRun() {
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putLong("strmLastRun", strmLastRun).apply();
        } catch (Throwable ignore) {}
    }

    /**
     * 把 strm 库的内容版本落盘（同 strmTouchLastRun 的理由：不是配置变更，不该走 persistConfig）。
     *
     * ⚠️ 为什么**不**在每次自增时立刻写：一轮里可能写几千个 .strm，那就是几千次
     *    SharedPreferences 写入。只在任务收尾写一次就够了 —— 前端只在任务跑完才看版本号。
     */
    private void strmTouchRev() {
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putLong("strmRev", strmRev).apply();
        } catch (Throwable ignore) {}
    }

    /** 增量 manifest 位置：filesDir/strm_manifest.json（应用私有目录，系统不随手清） */
    private File strmManifestFile() {
        return new File(ctx.getFilesDir(), "strm_manifest.json");
    }

    /** 读增量 manifest：视频路径 → strm 落点。坏文件按空处理（顶多全量重传一遍） */
    private JSONObject strmManifestLoad() {
        File f = strmManifestFile();
        if (!f.isFile() || f.length() == 0) return new JSONObject();
        try {
            byte[] buf = new byte[(int) f.length()];
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            int n = 0;
            while (n < buf.length) {
                int r = in.read(buf, n, buf.length - n);
                if (r < 0) break;
                n += r;
            }
            in.close();
            JSONObject o = new JSONObject(new String(buf, 0, n, "UTF-8"));
            Log.i(TAG, "strm manifest 读回 " + o.length() + " 条");
            return o;
        } catch (Throwable t) {
            Log.w(TAG, "strm manifest 读取失败，当作空 " + t.getMessage());
            return new JSONObject();
        }
    }

    /** manifest 落盘（先写 .part 再改名，中途被杀不留半份坏文件 —— 与片库缓存同一套） */
    private void strmManifestSave(JSONObject m) {
        File f = strmManifestFile();
        File tmp = new File(f.getParentFile(), "strm_manifest.json.part");
        try {
            FileOutputStream os = new FileOutputStream(tmp);
            os.write(m.toString().getBytes("UTF-8"));
            os.flush();
            os.close();
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); }
        } catch (Throwable t) {
            Log.w(TAG, "strm manifest 落盘失败 " + t.getMessage());
            try { tmp.delete(); } catch (Throwable ignore) {}
        }
    }

    /* =====================================================================================
     *                          strm 备份 / 还原（2026-09-20）
     * ===================================================================================== */

    /** 备份文件名里的时间戳（下载目录里放多份备份时一眼能分清） */
    private static String strmBkStamp() {
        return new java.text.SimpleDateFormat("yyyyMMdd-HHmm", java.util.Locale.US)
                .format(new java.util.Date());
    }

    /**
     * 把相对路径安全地拼到 root 之下，**防 zip slip**。
     *
     * 备份包可能是用户从别处拿来的（微信转的、网盘下的），里面完全可能带着
     * `../../databases/xxx` 这种条目 —— 直接 `new File(root, rel)` 解压就是
     * 经典 zip slip：能写到应用私有目录之外。所以这里三层拦：
     *   ① 去前导斜杠、统一分隔符；
     *   ② 显式挡 `..` 段和盘符；
     *   ③ 最后用 canonicalPath 再确认一遍「确实在 root 里面」（软链接也一起挡了）。
     *
     * @return 合法则返回目标 File，非法返回 null（调用方按「拒绝」计数）
     */
    private static File safeChild(File root, String rel) {
        if (rel == null) return null;
        String r = rel.replace('\\', '/').trim();
        while (r.startsWith("/")) r = r.substring(1);
        if (r.isEmpty()) return null;
        if (r.length() > 1 && r.charAt(1) == ':') return null;          // C:/ 之类
        String[] seg = r.split("/");
        for (String s : seg) if (s.isEmpty() || "..".equals(s)) return null;
        File f = new File(root, r);
        try {
            String rp = root.getCanonicalPath();
            String fp = f.getCanonicalPath();
            if (!fp.equals(rp) && !fp.startsWith(rp + File.separator)) return null;
        } catch (Throwable t) {
            return null;
        }
        return f;
    }

    private static byte[] readAllBytes(File f) throws Exception {
        byte[] buf = new byte[(int) f.length()];
        java.io.FileInputStream in = new java.io.FileInputStream(f);
        try {
            int n = 0;
            while (n < buf.length) {
                int r = in.read(buf, n, buf.length - n);
                if (r < 0) break;
                n += r;
            }
            if (n == buf.length) return buf;
            byte[] t = new byte[n];
            System.arraycopy(buf, 0, t, 0, n);
            return t;
        } finally {
            try { in.close(); } catch (Throwable ignore) {}
        }
    }

    /** 往 zip 里塞一条（名字用 UTF-8，中文目录名在 Windows 解压也不会乱码） */
    private static void putZip(java.util.zip.ZipOutputStream z, String name, byte[] data) throws Exception {
        java.util.zip.ZipEntry e = new java.util.zip.ZipEntry(name);
        e.setTime(System.currentTimeMillis());
        z.putNextEntry(e);
        z.write(data);
        z.closeEntry();
    }

    /** 递归把 strm 目录塞进 zip；返回写进去的文件条数 */
    private static int zipTree(java.util.zip.ZipOutputStream z, File dir, String prefix) throws Exception {
        File[] kids = dir.listFiles();
        if (kids == null) return 0;
        /* 排序只为「同样内容导出两次，条目顺序一致」，方便人比对（不影响正确性） */
        java.util.Arrays.sort(kids, (a, b) -> a.getName().compareTo(b.getName()));
        int n = 0;
        for (File k : kids) {
            if (k.getName().endsWith(".part")) continue;                 // 半成品不备份
            if (k.isDirectory()) { n += zipTree(z, k, prefix + k.getName() + "/"); continue; }
            if (!k.isFile()) continue;
            putZip(z, STRM_BK_PREFIX + prefix + k.getName(), readAllBytes(k));
            n++;
        }
        return n;
    }

    /**
     * 打包一份完整备份写进 out。
     * @return 写进去的 strm 文件条数（元信息/索引不算）
     */
    int strmBackupWrite(OutputStream out) throws Exception {
        java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(out);
        z.setLevel(java.util.zip.Deflater.BEST_SPEED);
        int n;
        try {
            JSONObject meta = new JSONObject();
            meta.put("format", STRM_BK_FORMAT);
            meta.put("app", "com.nas.douyin");
            meta.put("exportedAt", System.currentTimeMillis());
            try {
                android.content.pm.PackageInfo pi =
                        ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
                meta.put("versionName", pi.versionName == null ? "" : pi.versionName);
            } catch (Throwable ignore) {}
            JSONArray sj = new JSONArray();
            for (String s : strmJobs) sj.put(s);
            meta.put("strmJobs", sj);
            /* 🔴 片源也必须进备份（2026-09-20 补）：换机最要紧的就是它 ——
               只带 .strm 文件与监控清单的话，新机的「片源」栏是空的，
               首页一条视频都没有，用户以为白导了（真机实测就是这样报到我这儿的）。
               ⚠️ 刻意**不带** url / user / pass：那是一份放在「下载」目录里的 zip，
                  把 NAS 密码写进去等于随手把凭据散出去；换机时重新填一次更安全，
                  也避免把旧服务器地址带过去。
               ⚠️ 也**不带** recursive / maxDepth / fit：那是扫描与播放偏好，
                  不是「strm 库」的一部分，带错了会悄悄改变新机的扫描行为。 */
            JSONArray sd = new JSONArray();
            for (String s : dirs) sd.put(s);
            meta.put("dirs", sd);
            JSONArray sk = new JSONArray();
            for (String s : skipDirs) sk.put(s);
            meta.put("skipDirs", sk);
            meta.put("dir", dir);
            meta.put("strmIntervalH", strmIntervalH);
            /* 体积阈值属于「strm 库」自己的配置（不像 recursive/maxDepth/fit 那种扫描偏好），
               所以跟着备份走 —— 换机后新机的库应该跟老机长得一样。 */
            meta.put("strmMinSizeMB", strmMinSizeMB);
            /* 记下 `local:/` 的语义来源，将来格式真要变时，老包也能靠它判断怎么解释 */
            meta.put("localPrefix", LOCAL_PREFIX);
            putZip(z, STRM_BK_META, meta.toString().getBytes("UTF-8"));

            File mf = strmManifestFile();
            if (mf.isFile() && mf.length() > 0) putZip(z, STRM_BK_MANIFEST, readAllBytes(mf));

            File root = new File(strmLocalDir());
            n = root.isDirectory() ? zipTree(z, root, "") : 0;
            z.finish();
        } finally {
            try { z.close(); } catch (Throwable ignore) {}
        }
        return n;
    }

    /** 逐条把 zip 条目读成 byte[]（备份包里全是小文件，一条几十字节，内存放得下） */
    private static byte[] readEntry(java.util.zip.ZipInputStream z) throws Exception {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int r;
        while ((r = z.read(buf)) > 0) {
            bos.write(buf, 0, r);
            if (bos.size() > 8 * 1024 * 1024) throw new Exception("单条备份内容过大");
        }
        return bos.toByteArray();
    }

    /**
     * 还原一份备份：strm 文件回填本机、索引并入 manifest、监控清单补齐。
     *
     * 冲突策略 = **合并补缺**（用户拍板）：同路径文件已存在就跳过 ——
     *   ① 重复导入天然安全；
     *   ② 不会把本机「更新过的」.strm 内容回滚成备份里的旧内容
     *      （换过 NAS 地址的话，那反而是帮倒忙）。
     * 为了让「跳过」不至于变成黑箱，额外统计其中**内容不同**的有多少条。
     */
    JSONObject strmBackupRead(InputStream in) throws Exception {
        File root = new File(strmLocalDir());
        if (!root.isDirectory() && !root.mkdirs()) {
            throw new Exception("strm 目录建不出来：" + root.getAbsolutePath());
        }
        int added = 0, skipped = 0, skippedDiff = 0, rejected = 0;
        long bytes = 0;
        JSONObject meta = null;
        byte[] manBytes = null;

        java.util.zip.ZipInputStream z = new java.util.zip.ZipInputStream(in);
        java.util.zip.ZipEntry e;
        while (true) {
            try {
                e = z.getNextEntry();
            } catch (java.util.zip.ZipException ze) {
                /* 🔴 平台自身就会先挡一道：条目名里带 `..` 时 ZipInputStream 直接抛
                   `ZipException("Invalid zip entry path: …")` —— 比我们的 safeChild 更早。
                   （真机实测过，所以 safeChild 里的 `..` 判断属于「纵深防御」，留着。）
                   但一个坏条目会让整个 zip 读不下去 → 只能中止。这里**别把英文异常
                   原样抛给用户**，翻成人话并说清「已导入的会保留」：
                   导出/合并都不删不覆盖，所以中止不会造成损坏，只是没导全。 */
                throw new Exception("备份包不合法，已中止（" + ze.getMessage() + "）。"
                        + "此前已导入的文件会保留，不会覆盖或删除任何东西；换一份备份重试即可。");
            }
            if (e == null) break;
            String name = e.getName() == null ? "" : e.getName().replace('\\', '/');
            if (name.endsWith("/") || name.isEmpty()) { z.closeEntry(); continue; }
            byte[] data = readEntry(z);
            if (STRM_BK_META.equals(name)) {
                try { meta = new JSONObject(new String(data, "UTF-8")); } catch (Throwable ignore) {}
                z.closeEntry();
                continue;
            }
            if (STRM_BK_MANIFEST.equals(name)) { manBytes = data; z.closeEntry(); continue; }
            if (!name.startsWith(STRM_BK_PREFIX)) { rejected++; z.closeEntry(); continue; }
            File dest = safeChild(root, name.substring(STRM_BK_PREFIX.length()));
            if (dest == null) { rejected++; z.closeEntry(); continue; }
            File par = dest.getParentFile();
            if (par != null && !par.isDirectory() && !par.mkdirs()) { rejected++; z.closeEntry(); continue; }
            if (dest.isFile()) {
                skipped++;
                try {
                    if (!java.util.Arrays.equals(readAllBytes(dest), data)) skippedDiff++;
                } catch (Throwable ignore) {}
            } else {
                FileOutputStream os = new FileOutputStream(dest);
                try { os.write(data); } catch (Throwable t) { try { os.close(); } catch (Throwable ignore) {} throw t; }
                os.close();
                added++;
                strmRev++;                       // 导入也是「库变了」→ 该让前端重传备份
            }
            bytes += data.length;
            z.closeEntry();
        }

        /* ---- 增量索引：并集合并，**本机已有条目优先**（本机更可信） ---- */
        JSONObject mres = new JSONObject();
        if (manBytes != null) {
            JSONObject inc = null;
            try { inc = new JSONObject(new String(manBytes, "UTF-8")); } catch (Throwable ignore) {}
            if (inc != null) {
                JSONObject cur = strmManifestLoad();
                int before = cur.length(), addedM = 0;
                java.util.Iterator<String> it = inc.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    if (!cur.has(k)) { cur.put(k, inc.opt(k)); addedM++; }
                }
                if (addedM > 0) { strmManifestSave(cur); strmRev++; }
                mres.put("added", addedM);
                mres.put("had", before);
                mres.put("now", cur.length());
            }
        }

        /* ---- 片源 / 监控清单 / 间隔：一律只**补缺**，绝不覆盖你现在的设置 ---- */
        JSONArray addedJobs = new JSONArray();
        JSONArray addedDirs = new JSONArray();
        JSONArray addedSkips = new JSONArray();
        int ivApplied = -1;
        if (meta != null) {
            JSONObject body = new JSONObject();
            boolean changed = false;

            /* 片源：并集（本机在前）。换机时本机是空的 → 就等于整套照搬备份。 */
            List<String> nextDirs = new ArrayList<>(dirs);
            JSONArray sd = meta.optJSONArray("dirs");
            if (sd != null) {
                for (int i = 0; i < sd.length(); i++) {
                    String s = sd.optString(i, "").trim();
                    if (s.isEmpty()) continue;
                    String nrm = normSrc(s);
                    if (!nextDirs.contains(nrm)) { nextDirs.add(nrm); addedDirs.put(nrm); }
                }
            }
            if (addedDirs.length() > 0) {
                JSONArray arr = new JSONArray();
                for (String s : nextDirs) arr.put(s);
                body.put("dirs", arr);
                changed = true;
            }
            /* 当前目录：只在「空着、或已经不在片源里」时才跟一下 —— **直接改字段**，
               与 handleSources 的 `dir = dirs.get(0)` 同源。
               🔴 别把它塞进 body 走 handleConfig：那条路对 dir 做 normAbs，
                  而 `local:/` 会被规成 `/local:` —— 本机片源的前缀判据（startsWith("local:")）
                  当场失效，浏览器/播放那条路会把它当 WebDAV 路径（真踩过）。 */
            if (!nextDirs.isEmpty() && (dir == null || dir.isEmpty() || !nextDirs.contains(dir))) {
                dir = nextDirs.get(0);
                changed = true;
            }
            /* 「不重扫」标记：并集，但只认仍在片源里的（跟 handleConfig 的收敛规则一致） */
            List<String> nextSkip = new ArrayList<>(skipDirs);
            JSONArray sk = meta.optJSONArray("skipDirs");
            if (sk != null) {
                for (int i = 0; i < sk.length(); i++) {
                    String s = sk.optString(i, "").trim();
                    if (s.isEmpty()) continue;
                    String nrm = normSrc(s);
                    if (nextDirs.contains(nrm) && !nextSkip.contains(nrm)) { nextSkip.add(nrm); addedSkips.put(nrm); }
                }
            }
            if (addedSkips.length() > 0) {
                JSONArray arr = new JSONArray();
                for (String s : nextSkip) arr.put(s);
                body.put("skipDirs", arr);
                changed = true;
            }

            List<String> next = new ArrayList<>(strmJobs);
            JSONArray sj = meta.optJSONArray("strmJobs");
            if (sj != null) {
                for (int i = 0; i < sj.length(); i++) {
                    String s = sj.optString(i, "").trim();
                    if (s.isEmpty()) continue;
                    String nrm = NasService.normAbs(s);
                    if (!next.contains(nrm)) { next.add(nrm); addedJobs.put(nrm); }
                }
            }
            int iv = meta.optInt("strmIntervalH", 0);
            if (addedJobs.length() > 0) {
                JSONArray arr = new JSONArray();
                for (String s : next) arr.put(s);
                body.put("strmJobs", arr);
                changed = true;
            }
            /* 间隔只在**本机还没设过**（0）时才补 —— 否则等于偷偷改用户现有设置 */
            if (iv > 0 && strmIntervalH == 0) { body.put("strmIntervalH", iv); ivApplied = iv; changed = true; }
            /* 体积阈值同理：只在**本机还是 0（没设过）**时才补，别偷偷改用户现有设置 */
            int mv = meta.optInt("strmMinSizeMB", 0);
            if (mv > 0 && strmMinSizeMB == 0) { body.put("strmMinSizeMB", mv); changed = true; }
            if (changed) handleConfig("POST", body);   // 内部会 persistConfig + strmSchedule
        }

        /* 🔴 兜底把本机片源加回去（2026-09-20 晚）。
         *
         * 背景：`dirs` 是我**当天晚些时候**才加进备份的字段，在那之前导出的包里没有它；
         * 而用户换机时用的往往正是那份旧包。于是上面那段「片源并集」等于什么都没做 ——
         * 结果就是**文件全回来了、监控清单也回来了、首页却一条视频都没有**，
         * 用户的原话是「导入 strm 备份不生效」。
         *
         * 判据取「strm 根目录里真的落了 .strm」而不是「备份里有没有文件」：
         * 合并补缺模式下一个都没写（全是跳过）也算导入成功，那时磁盘上同样是有文件的。
         *
         * `strmRegisterLocalSrc()` 自带两道门（目录不存在不add / 已在清单里直接 return），
         * 所以这里调用是幂等的；它顺带置的 `localSrcAdded` 一次性标记还能让前端
         * 把界面切到本机片源并刷新片库（否则用户导完还是停在空的首页）。 */
        if (!dirs.contains(LOCAL_PREFIX + "/") && countStrmFiles(root) > 0) {
            strmRegisterLocalSrc();
            if (dirs.contains(LOCAL_PREFIX + "/")) addedDirs.put(LOCAL_PREFIX + "/");
        }

        JSONObject files = new JSONObject();
        files.put("added", added);
        files.put("skipped", skipped);
        files.put("skippedDiff", skippedDiff);
        files.put("rejected", rejected);
        files.put("bytes", bytes);

        JSONObject jobs = new JSONObject();
        jobs.put("added", addedJobs);
        JSONArray nowJobs = new JSONArray();
        for (String s : strmJobs) nowJobs.put(s);
        jobs.put("now", nowJobs);
        jobs.put("intervalH", strmIntervalH);
        jobs.put("intervalApplied", ivApplied);
        /* 片源相关（2026-09-20 补）：前端拿到 dirsAdded 就得重扫片库，
           不然新机导完备份，首页还是空的（片源有了但片库没扫）。 */
        jobs.put("dirsAdded", addedDirs);
        jobs.put("skipDirsAdded", addedSkips);
        JSONArray nowDirs = new JSONArray();
        for (String s : dirs) nowDirs.put(s);
        jobs.put("dirs", nowDirs);

        JSONObject o = new JSONObject();
        o.put("ok", true);
        o.put("files", files);
        o.put("manifest", mres);
        o.put("jobs", jobs);
        o.put("localDir", strmLocalDir());
        o.put("meta", meta == null ? JSONObject.NULL : meta);
        /* 导入也算「库变了」→ 把版本号递增并落盘，顺手回报给前端。
           前端拿到新值就直接记为「已备份」，省掉一次 /api/strmjob 往返；
           不这么做的话，从账号拉完备份会立刻被自己判定成「库变了」再传一遍。 */
        strmRev++;
        strmTouchRev();
        o.put("rev", strmRev);
        return o;
    }

    /**
     * GET /api/strm/backup —— 下载一份完整备份 zip。
     * 文件名带时间戳：下载目录里放好几份也能一眼分清是哪天导的。
     * ⚠️ 整包在内存里拼（备份包都是几十字节一条的小文件，实测 5269 条 ≈ 300KB）；
     *    真到几十 MB 那种规模再改成落临时文件 + stream，现在不值得。
     */
    private Resp handleStrmBackup() {
        try {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream(1 << 20);
            int n = strmBackupWrite(bos);
            Resp r = new Resp();
            r.headers.put("Content-Type", "application/zip");
            r.headers.put("Content-Disposition",
                    "attachment; filename=\"nas-strm-backup-" + strmBkStamp() + ".zip\"");
            r.body = bos.toByteArray();
            Log.i(TAG, "strm 备份导出：" + n + " 个文件 / " + r.body.length + " 字节");
            return r;
        } catch (Throwable t) {
            Log.w(TAG, "strm 备份导出失败 " + t.getMessage());
            return json(500, err("导出失败：" + t.getMessage()));
        }
    }

    /**
     * POST /api/strm/restore —— body 就是备份 zip 的字节（**不是** JSON）。
     * ⚠️ 前端上传时别加 `Content-Type: application/json`，否则这里会先按 JSON 解析一遍
     *    （parseJsonBody 失败只是返回空对象，不影响 req.body，但语义上容易误导）。
     */
    private Resp handleStrmRestore(Req req) {
        if (req.body == null || req.body.length == 0) return json(400, err("没有收到备份内容"));
        try {
            JSONObject o = strmBackupRead(new java.io.ByteArrayInputStream(req.body));
            Log.i(TAG, "strm 备份导入：" + o.optJSONObject("files"));
            return json(200, o);
        } catch (Throwable t) {
            Log.w(TAG, "strm 备份导入失败 " + t.getMessage());
            return json(500, err("导入失败：" + t.getMessage()));
        }
    }

    /**
     * GET  /api/strmjob              —— 状态：进度 + 配置回显 + 是否已过期未扫（stale）
     * POST /api/strmjob {run:true}   —— 手动触发一轮（已在跑则回 state=already-running）
     */
    private Resp handleStrmJob(String method, JSONObject body) {
        if ("POST".equals(method)) {
            if (!body.optBoolean("run", false)) return json(400, err("missing run:true"));
            /* 配置不完整时同步拦下（不 CAS、不起新线程）—— 错误立刻回显到状态行，
               而不是靠线程跑起来再失败、前端下一次轮询才能看到。
               🔴 输出位置固定了 → 这里只剩「勾没勾目录」一个前提（见字段头上 A 段）。 */
            if (strmJobs.isEmpty()) {
                strmLastError = "请先添加要监控的文件夹";
                return json(200, strmStatusJson("idle"));
            }
            boolean started = strmRunAsync();
            return json(200, strmStatusJson(started ? "started" : "already-running"));
        }
        return json(200, strmStatusJson(null));
    }

    /*
     * =====================================================================================
     *  已删除：strmLocalPermOk()（2026-09-20 二次改版）
     * =====================================================================================
     *  它探测「有没有所有文件访问权限」（API30+ isExternalStorageManager / 旧系统 WRITE）。
     *  之所以不再需要：strm 现在写进 App 自己的外部目录（getExternalFilesDir），
     *  那是**免授权**的。状态体里的 permOk 字段也一并去掉。
     *  ⚠️ 别加回来 —— 它只会让前端又长出一套「权限没给」的提示 UI。
     */

    /** /api/strmjob 的状态体（GET / POST 触发后共用一份字段） */
    private JSONObject strmStatusJson(String state) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            if (state != null) o.put("state", state);
            o.put("running", strmRunning.get());
            /* `local` 仍回报 —— 但它是**固定目录**（strmLocalDir()），
               前端拿它只读展示，不是用户配的值。
               ⚠️ 不再有 `out`（NAS 回传）和 `permOk`（免授权了），别再补回来。 */
            o.put("local", strmLocalDir());
            JSONArray ja = new JSONArray();
            for (String s : strmJobs) ja.put(s);
            o.put("jobs", ja);
            o.put("intervalH", strmIntervalH);
            o.put("done", strmDone);
            o.put("total", strmTotal);
            o.put("added", strmAdded);
            o.put("skipped", strmSkipped);
            /* 「小于体积阈值被跳过」的条数（2026-09-22）。前端只在 >0 时才显示，
               免得状态行里恒多一个 0。 */
            o.put("minSkipped", strmTooSmall);
            o.put("failed", strmFailed);
            o.put("lastRunAt", strmLastRun);
            /* strm 库的内容版本（2026-09-22）。前端拿它跟本地记的值比：
               不一样就说明库变过 → 自动把备份重传到同步账号。
               ⚠️ 别用 lastRunAt 代替 —— 全增量命中的一轮也会让它变，
                  那样每轮都要白传一遍备份。 */
            o.put("rev", strmRev);
            o.put("lastError", strmLastError);
            // 过期未扫：定时开着且距上次完成已超过一个周期（前端拿它提示「该扫了」）
            o.put("stale", strmIntervalH > 0 && strmLastRun > 0
                    && System.currentTimeMillis() - strmLastRun >= strmIntervalH * 3600_000L);
            /* 「刚因为 strm 生成而自动加了本机片源」—— 一次性标记，读取即清除。
               前端看到它就静默拉一次片库（那批 .strm 才刷得出来）；
               不这么做的话，用户生成完回到首页会发现「什么都没有」，
               得手动去片源栏点一下才出现。 */
            o.put("localSrcAdded", localSrcJustAdded.getAndSet(false));
        } catch (Exception ignore) {}
        return o;
    }

    /**
     * strm 里写的完整 URL 若指向**本机 CD2 的 WebDAV**（http://127.0.0.1:19798/dav/...），
     * 不能 302 过去 —— CD2 的 dav 强制 Basic 认证，WebView / 原生播放器跟过去
     * 不会带凭据，只会吃 401。识别出来换成对应 WebDAV 路径，走内部代理。
     * 不是本机 dav URL 就返回 null（交给 302）。
     */
    /**
     * 当前 WebDAV 配置是否指向**本机内置的 CD2 引擎**（127.0.0.1/localhost/::1 + 19798）。
     *
     * 为什么需要它：401 的归因**两码事** ——
     *   · 连远程 NAS：401 = 那台服务器的账号密码不对 → 让人去重填密码；
     *   · 连本机引擎：401 绝大多数是**引擎里还没登录 CD2 账号**（WebDAV 凭据就是 CD2 账号），
     *     此时密码是对的，重填密码无济于事 → 要指去第 1 步「打开 CloudDrive2 管理」。
     * 2026-09-20 实测：模拟器上引擎起来了、管理页却是登录表单，扫描/strm 一律 401，
     * 而旧文案只让人「重填密码」—— 用户会一直打转。
     */
    private boolean isLocalCd2Dav() {
        try {
            java.net.URL u = new java.net.URL(baseUrl);
            String host = u.getHost();
            boolean local = "127.0.0.1".equals(host) || "localhost".equals(host) || "::1".equals(host);
            return local && u.getPort() == MainActivity.CD2_PORT;
        } catch (Throwable t) {
            return false;
        }
    }

    private String localDavPathOf(String url) {
        try {
            java.net.URL u = new java.net.URL(url);
            String host = u.getHost();
            boolean local = "127.0.0.1".equals(host) || "localhost".equals(host) || "::1".equals(host);
            if (!local) return null;
            String path = u.getPath();          // 未解码的 path（URL.getPath 不做 percent-decode）
            if (path == null || !path.startsWith("/dav/")) return null;
            String sub = path.substring("/dav".length());
            // 手动解码（+ 在 path 里是字面量，先转义掉再 decode，避免被翻成空格）
            String decoded = java.net.URLDecoder.decode(sub.replace("+", "%2B"), "UTF-8");
            return NasService.normAbs(decoded);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 302 重定向到目标 URL。
     * Location 头只允许 ASCII：非 ASCII / 空格 / 控制符按 UTF-8 percent-encode
     * （中文文件名直出的 URL 不编码的话，WebView 收到非法响应头直接判失败）。
     * 客户端（Chromium media stack / ExoPlayer 的 DefaultHttpDataSource）跟随重定向时
     * 会带着原 Range 头重新请求 Location，断点续播不受影响。
     */
    private static Resp seeOther(String url) {
        StringBuilder sb = new StringBuilder(url.length() + 32);
        for (byte b : url.getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
            int c = b & 0xFF;
            if (c <= 0x20 || c >= 0x7F || c == '<' || c == '>' || c == '"') {
                sb.append('%').append(String.format(java.util.Locale.US, "%02X", c));
            } else {
                sb.append((char) c);
            }
        }
        Resp r = new Resp();
        r.status = 302;
        r.headers.put("Location", sb.toString());
        r.headers.put("Cache-Control", "no-store");
        r.headers.put("Access-Control-Allow-Origin", "*");
        r.body = new byte[0];
        return r;
    }

    /** 对一个 WebDAV 绝对路径拉上游流（原 handleStream 的主体，strm 解析后也走这里） */
    private Resp streamUpstream(String abs, Req req) {
        String target = dav.absUrl(abs);

        java.net.HttpURLConnection up = null;
        try {
            java.net.URL u = new java.net.URL(target);
            up = (java.net.HttpURLConnection) u.openConnection();
            up.setConnectTimeout(8000);
            up.setReadTimeout(30000);
            up.setRequestProperty("User-Agent", "douyin-nas-android");
            if (user != null && !user.isEmpty()) {
                String auth = "Basic " + android.util.Base64.encodeToString(
                        (user + ":" + pass).getBytes(java.nio.charset.StandardCharsets.UTF_8),
                        android.util.Base64.NO_WRAP);
                up.setRequestProperty("Authorization", auth);
            }
            String range = req.headers.get("Range");
            if (range != null) up.setRequestProperty("Range", range);

            int code = up.getResponseCode();
            String contentType = up.getHeaderField("Content-Type");
            if (contentType == null) contentType = "video/mp4";

            Resp r = new Resp();
            r.status = code;
            r.headers.put("Content-Type", contentType);
            r.headers.put("Accept-Ranges", "bytes");
            r.headers.put("Cache-Control", "no-store");
            r.headers.put("Access-Control-Allow-Origin", "*");
            copyHeader(up, r.headers, "Content-Length");
            copyHeader(up, r.headers, "Content-Range");
            copyHeader(up, r.headers, "ETag");
            copyHeader(up, r.headers, "Last-Modified");

            InputStream is = (code >= 400) ? up.getErrorStream() : up.getInputStream();
            if (is == null) {
                r.body = new byte[0];
                return r;
            }
            r.stream = is;
            r.streamLen = up.getContentLengthLong();
            if (r.streamLen >= 0) r.headers.put("Content-Length", String.valueOf(r.streamLen));
            return r;
        } catch (Exception e) {
            Log.w(TAG, "拉流失败 " + abs + " " + e.getMessage());
            return json(502, err("拉流失败: " + e.getMessage()));
        }
    }

    /**
     * `/api/transcode` —— ⚠️ **在 APK 里它不是真转码**，请先读懂这一点再改。
     *
     * =====================================================================================
     *  2026-09-18 回退：APK 回到「单机自包含」路线，不再转发给 NAS 的解码服务
     * =====================================================================================
     *  APK 里**没有 ffmpeg**（内嵌那套 `startFfmpeg` / `waitFirstBytes` / `encodeArgs` /
     *  `ProcStream` 早已删除，就是为了把 APK 从 40MB 压回 10MB）。所以手机端
     *  **根本没有真正的转码能力**，这个接口实际做的是「把原文件当直连流吐出去」。
     *
     *  曾经短暂改成「转发给飞牛 NAS 上的 Docker 解码服务」（见 decode-server/），
     *  现已按用户要求回退 —— 那套要求用户额外部署一个容器，对单机使用是负担。
     *
     * =====================================================================================
     *  这对 seek 意味着什么（前端 app.js 依赖这条约定）
     * =====================================================================================
     *  既然是原文件直通，那它**天然支持 HTTP Range**（handleStream 会转发 Range 头，
     *  并回 `Accept-Ranges: bytes`）。所以浏览器/Media3 可以**原生 seek**，
     *  拖进度条只要改 `video.currentTime` 就行，**绝对不要为此重开一路流**。
     *
     *  为此这里额外打一个 `X-Seekable: 1` 标记，给前端 `canNativeSeek()` 判断用。
     *  （为什么不直接靠 `seekable` 猜测：刚起流时 seekable 可能还没铺开，
     *   有个明确的正向标记最稳。）
     *
     *  ⚠️ 与 Node 版（server.js）的差异：那边可以配一个远端地址去真转发、否则本地 ffmpeg；
     *     APK 这边两者都没有，所以**只走直通**这一条路。改的时候别互相照抄。
     *
     *  `t` / `mode` / `h` / `q` 这些转码参数在本接口里**会被忽略** ——
     *  前端在 APK 场景不应依赖它们；真正的 seek 走 `currentTime`。
     */
    private Resp handleTranscode(Req req, Map<String, String> q) {
        // 直通原文件，并在响应上加「这个流原生可 seek」的标记。
        Resp r = handleStream(req, q);
        if (r != null && r.status < 400) {
            // 直连流一定支持 Range（handleStream 里已回 Accept-Ranges: bytes）
            r.headers.put("X-Seekable", "1");
            // 兼容前端既有分支：它见到 X-Transcode 才走转码那条路径。
            // 但值**不能**是 "remux"/"encode"（那会让前端以为需要重启流），
            // 用 "passthrough" 明确表示「没转，就是原文件」。
            r.headers.put("X-Transcode", "passthrough");
        }
        return r;
    }


    /** 只编码 query 值，保留键的 = 与 & 交给调用方 */
    private static String urlEnc(String s) {
        try { return java.net.URLEncoder.encode(s, "UTF-8"); }
        catch (Exception e) { return s; }
    }

    /*
     * =====================================================================================
     *  已删除：handleCaps()（2026-09-18 Phase L 回退）
     * =====================================================================================
     *  它原来只干一件事：把「NAS 上那个 Docker 解码服务」的 /api/caps 转述给前端，
     *  好让设置页的「测试解码服务」按钮能绕过 CORS 问出对面能不能转码。
     *  解码服务整条路线回退了，这个接口自然没有存在意义 —— /api/caps 路由也一并删了，
     *  访问会落到 404（这是对的：老前端问它就是在问一个已经不存在的功能）。
     *
     *  readShort() / disconnect() **保留**：它们不只为 handleCaps 服务，
     *  handleStream 这些转发路径也在用（读上游错误体、断连接）。
     */

    /** 读一小段上游的错误体，用来拼一句能给用户看的原因（不阻塞在长流上） */
    private static String readShort(InputStream is, int max) {
        if (is == null) return "";
        try {
            byte[] b = new byte[max];
            int n = is.read(b);
            return n > 0 ? new String(b, 0, n, "UTF-8").trim() : "";
        } catch (Throwable t) {
            return "";
        }
    }

    private static void disconnect(java.net.HttpURLConnection c) {
        if (c == null) return;
        try { c.disconnect(); } catch (Throwable ignored) { }
    }

    private static String mimeOf(String path) {
        String ext = NasService.extOf(path == null ? "" : path);
        switch (ext) {
            case "mp4": case "m4v": return "video/mp4";
            case "mov":  return "video/quicktime";
            case "webm": return "video/webm";
            case "ogv":  return "video/ogg";
            case "mkv":  return "video/x-matroska";
            case "avi":  return "video/x-msvideo";
            default:     return "video/mp4";
        }
    }

    private static void copyHeader(java.net.HttpURLConnection up, Map<String, String> out, String name) {
        String v = up.getHeaderField(name);
        if (v != null) out.put(name, v);
    }

    // ---------------------------------------------------------------- 路径工具（与 server.js 对齐）

    /** href → 相对 WebDAV 根的完整路径（server.js hrefToAbsPath） */
    static String hrefToAbs(String href) {
        String p = href == null ? "" : href;
        try {
            java.net.URL u = new java.net.URL(new java.net.URL("http://dav.local"), p);
            p = u.getPath();
        } catch (Exception ignore) {}
        try { p = java.net.URLDecoder.decode(p, "UTF-8"); } catch (Exception ignore) {}
        return NasService.normAbs(p);
    }

    /**
     * URL 里的 path 部分作为默认目录（与 server.js splitUrl + effectiveDir 对齐）。
     *
     * ⚠️ 返回的是**含前缀、去尾斜杠**的形态（`/dav`），根则是 `/`。
     * 与 DavClient.basePrefix 的区别：那边根挂载是空串 `""`，
     * 因为它是拿去参与 `startsWith` 拼接的，空串才安全；
     * 这里是给人看的「目录」，所以根归一成 `/` —— 但**比较前缀时不能直接用**，
     * 得先像下面 prefixOf() 那样把根换成空串，否则 `urlPath + "/"` 会拼出 `//`。
     */
    private String urlPath() {
        String p = prefixOf(baseUrl);
        return p.isEmpty() ? "/" : p;
    }

    /** baseUrl 里那段路径，去尾斜杠；根/空返回 ""（与 DavClient.basePrefix 同形态） */
    private static String prefixOf(String url) {
        try {
            String p = new java.net.URL(url.isEmpty() ? "http://x/" : url).getPath();
            if (p == null) return "";
            while (p.endsWith("/")) p = p.substring(0, p.length() - 1);
            return p;
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * 把任意 absPath 归一到「含 urlPath 前缀」的规范形态。
     *
     * 子路径挂载（CD2 的 `/dav`）时 `/`（服务根）和 `/dav`（挂载根）指的是**同一层**，
     * 必须归一 —— 否则列表会把挂载根自己列成一个子文件夹（`cp.equals(p)` 拿
     * `/dav` 比 `/` 永远不等），「上一级」还会走进一个面包屑空掉的幽灵根。
     * `effectiveDir` / `listDir` 都走这里，别再各写一份判据（那正是分叉的来源）。
     */
    private String mountAbs(String absPath) {
        String pfx = prefixOf(baseUrl);
        String d = NasService.normAbs(absPath);
        // pfx 为空=根挂载，不用补；已经是 pfx 本身/已带前缀 → 原样
        if (!pfx.isEmpty() && !d.equals(pfx) && !d.startsWith(pfx + "/")) {
            d = NasService.normAbs(pfx + d);
        }
        return d;
    }

    /**
     * 「配置里那个目录」在 **WebDAV 坐标系**里的形态（`/dav/115open/云下载`）。
     *
     * 🔴 **本机片源（`local:`）绝不能走这里**（2026-09-20 修）。
     *    它的坐标系跟 WebDAV 完全无关（`local:/` → 磁盘上 strmLocalDir 里的目录），
     *    可 `mountAbs` 会把它当相对路径补上前缀，`local:/` 就变成 `/dav/local:` ——
     *    一个**根本不存在的 WebDAV 路径**。后果：
     *      · `/api/config` 顶层 `dir` 回 `/dav/local:`（前端拿它当配置目录）；
     *      · `/api/browse` 传空路径 → PROPFIND `/dav/local:` → 404 →
     *        触发「配置目录失效」自愈兜底 → 弹一条莫名其妙的提示，
     *        而**用户压根没配过什么 NAS 目录**（他只有本机片源）。
     *    所以这里先判 `isLocalSrc`：是就返回空串，语义是「本机片源没有 WebDAV 目录」，
     *    让上层（browse 的空路径自愈、scan 的 defaultRoots）走各自的根目录分支。
     *    ⚠️ **不要**在这里退化成 `local:/` 原样返回 —— 那会拿本机前缀去 dav.propfind。
     */
    private String effectiveDir() {
        if (isLocalSrc(dir)) return "";
        String pfx = prefixOf(baseUrl);
        return mountAbs(dir.isEmpty() ? (pfx.isEmpty() ? "/" : pfx) : dir);
    }

    private List<String[]> crumbsOf(String absPath) {
        List<String[]> out = new ArrayList<>();
        String cur = "";
        for (String seg : NasService.normAbs(absPath).split("/")) {
            if (seg.isEmpty()) continue;
            cur += "/" + seg;
            out.add(new String[]{ seg, cur });
        }
        return out;
    }

    private String parentOf(String p) {
        String s = NasService.normAbs(p);
        if (s.equals("/")) return null;
        int i = s.lastIndexOf('/');
        return i <= 0 ? "/" : s.substring(0, i);
    }

    // ---------------------------------------------------------------- payload

    private JSONObject demoPayload() {
        JSONObject o = new JSONObject();
        try {
            o.put("videos", new JSONArray());
            o.put("source", "demo");
            o.put("scannedAt", System.currentTimeMillis());
            o.put("cached", false);
            o.put("scanning", false);
            o.put("dirs", new JSONArray());
        } catch (Exception ignore) {}
        return o;
    }

    private static JSONObject parseMap(String json) {
        try { return new JSONObject(json); } catch (Exception e) { return new JSONObject(); }
    }

    private static JSONObject err(String msg) {
        JSONObject o = new JSONObject();
        try { o.put("ok", false); o.put("error", msg); } catch (Exception ignore) {}
        return o;
    }

    private static Resp json(int code, JSONObject o) {
        Resp r = new Resp();
        r.status = code;
        r.headers.put("Content-Type", "application/json; charset=utf-8");
        r.headers.put("Cache-Control", "no-store");
        r.headers.put("Access-Control-Allow-Origin", "*");
        r.body = o.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        return r;
    }

    private static byte[] readAll(InputStream is) throws IOException {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    private static String hostOf(String url) {
        try { return new java.net.URL(url).getHost(); } catch (Exception e) { return "(无法解析)"; }
    }
}
