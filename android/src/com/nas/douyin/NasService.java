package com.nas.douyin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 把原来跑在电脑 Node 端的「扫描片库 + 格式化」逻辑搬到安卓。
 *
 * 输入：DavClient 列出的目录项；输出：前端 applyLibrary 要的 JSON 结构。
 * 算法与 server.js 的 scanLibrary / decorate / buildLibrary 保持 1:1 一致。
 */
public final class NasService {

    /** 我们**认**的视频后缀 —— 片库**全部列出**（与服务端 Node 版的 ALL_EXTS 同一个清单）。
     *  🔴 2026-09-19 放开：原来按「WebView 播不了」只列 mp4/m4v/mov/webm/ogv，
     *  结果 115 里的 mkv **全部消失**（用户报「添加片源后扫不到视频」）。
     *  现在 APK 用原生 Media3 播放器（PlayerActivity），Matroska/AVI/FLV/TS/PS
     *  提取器它都自带 —— 能不能播由 PLAYABLE_EXTS 决定，**列出来是另一回事**。
     *  ⚠️ 与电脑版 server.js 的 BROWSER_EXTS **故意不一致**：电脑版走浏览器 <video>，
     *     浏览器真解不了 mkv，那边仍只列 5 种。别再"统一"两边。 */
    static final String[] ALL_EXTS = {
        "mp4", "m4v", "mov", "webm", "ogv", "mkv", "avi", "flv", "wmv", "ts", "mpg", "mpeg", "3gp", "rmvb"
    };
    /** 上面这些里**能直接播、且用户要看的**（原生播放器有对应提取器 + 系统普遍带解码器）：
     *  mkv/webm（Matroska 提取器）、flv、ts、3gp、mp4 系。
     *  ⚠️ 扫描时**直接跳过**不进片库（2026-09-19 用户要求「avi/wmv/rmvb 扫描跳过」）：
     *     avi / wmv / rmvb 容器没有可靠的系统解码路径（avi 的编码太杂，常见的是
     *     系统解不了的 Xvid/老编码），mpg/mpeg 里几乎都是 MPEG-2 视频、Android 普遍
     *     没有 MPEG-2 解码器 —— 列出来只会让人点进去看错误卡片。
     *  ALL_EXTS 仍留着：管路径校验（stream / probe / 抽帧），与片库收录无关。
     *
     *  2026-09-19 再加 **strm**（用户要求「增加扫描播放 strm 的功能」）：
     *     .strm 是个文本文件，内容写一行 http(s) 直链或 WebDAV 路径 —— 播放时
     *     NasServer 解析出真目标再播（直链 302 过去，路径转内部代理）。用它可以把
     *     「媒体库清单」和「真正的视频」分开：app 只扫 strm 文件本身（小文本），
     *     直链直接打到网盘，不再需要反复递归列 115 目录 —— 正是给「持续扫描
     *     可能触发网盘风控」准备的逃生门。播放/解析细节见 NasServer.resolveStrm。 */
    static final String[] PLAYABLE_EXTS = {
        "mp4", "m4v", "mov", "webm", "ogv", "mkv", "flv", "ts", "3gp", "strm"
    };
    /** 扫描要跳过的目录名 */
    static final java.util.regex.Pattern SKIP_DIR =
        java.util.regex.Pattern.compile("^(\\.|@|#recycle|#snapshot|__MACOSX|\\$RECYCLE\\.BIN)", java.util.regex.Pattern.CASE_INSENSITIVE);

    /* ------------------------------------------------------------------
     * 三道上限（2026-09-18 按用户要求「全部扫出来」重新标定）
     * ------------------------------------------------------------------
     * 原来：800 条 / 45 秒 / 深度 8。实测 /dav/示例片源 **单一个片源**就有上万个视频，
     * 45 秒只够扫出 549 个 —— 而且**超时不报告**（NasServer 只在
     * `all.size() >= MAX_VIDEOS` 时置 truncated），用户以为扫全了。
     * 现在：20000 条 / 5 分钟 / 深度不限。配合下面的并发 BFS，
     * 实测 4000 个目录约 3.4 分钟（原来是 ~19 分钟串行）。 */
    static final int MAX_VIDEOS = 20000;
    static final int MAX_MS = 300000;
    /** 扫描深度上限（防呆，不是业务限制）。**0 = 不限**。 */
    static final int MAX_DEPTH_CAP = 32;
    /* 🔴 并发路数。原来**串行**递归（一个目录一个 PROPFIND 挨着来），
       CD2 不支持 Depth:3 只能一层层走，4000 个目录要 ~19 分钟。
       实测（_tools/bench-concurrency.js，60 个真实目录）：
         串行 16.9s / 8 并发 3.1s（快 5.5 倍）/ 16 并发 2.7s
       16 路只比 8 路快 12%，对 NAS 压力大一倍 —— **8 是甜点**。 */
    static final int CONCURRENCY = 8;

    /** 单条视频（与服务端 decorate 后的字段对齐） */
    public static class Video {
        public String p, name, mtime, ext, folder, author, title;
        public long size;
        public boolean playable;

        JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("p", p); o.put("name", name); o.put("size", size); o.put("mtime", mtime);
                o.put("ext", ext); o.put("playable", playable);
                o.put("folder", folder); o.put("author", author); o.put("title", title);
            } catch (Exception ignore) {}
            return o;
        }

        /**
         * toJson 的**逆操作**（2026-09-18 为「不重扫的文件夹」加的）。
         *
         * 标了「不重扫」的片源，扫描时整个跳过，直接把上一份片库里属于它的视频搬过来 ——
         * 而片库在内存里是 JSONObject，所以要有这条还原路径。
         * ⚠️ 必须与 toJson **字段一一对应**，少一个用户就会看到标题/作者变空的视频。
         */
        static Video fromJson(JSONObject o) {
            if (o == null) return null;
            String p = o.optString("p", "");
            if (p.isEmpty()) return null;
            Video v = new Video();
            v.p = p;
            v.name = o.optString("name", "");
            v.size = o.optLong("size", 0);
            v.mtime = o.optString("mtime", "");
            v.ext = o.optString("ext", "");
            v.playable = o.optBoolean("playable", isPlayableExt(v.ext));
            v.folder = o.optString("folder", "");
            v.author = o.optString("author", "");
            v.title = o.optString("title", "");
            return v;
        }
    }

    static String extOf(String name) {
        int i = name == null ? -1 : name.lastIndexOf('.');
        return i < 0 ? "" : name.substring(i + 1).toLowerCase();
    }

    static boolean isPlayableExt(String ext) {
        for (String e : PLAYABLE_EXTS) if (e.equals(ext)) return true;
        return false;
    }

    static boolean isVideoExt(String ext) {
        for (String e : ALL_EXTS) if (e.equals(ext)) return true;
        return false;
    }

    /** 与服务端 normAbs 一致：去 .. / . / 空段，统一 / 开头 */
    static String normAbs(String p) {
        String s = (p == null ? "" : p).trim().replace('\\', '/');
        if (!s.startsWith("/")) s = "/" + s;
        List<String> out = new ArrayList<>();
        for (String seg : s.split("/")) {
            if (seg.isEmpty() || seg.equals(".")) continue;
            if (seg.equals("..")) { if (!out.isEmpty()) out.remove(out.size() - 1); continue; }
            out.add(seg);
        }
        return "/" + String.join("/", out);
    }

    static String baseNameOf(String p) {
        String n = normAbs(p);
        while (n.endsWith("/")) n = n.substring(0, n.length() - 1);
        int i = n.lastIndexOf('/');
        return i < 0 ? n : n.substring(i + 1);
    }

    static String folderOf(String p) {
        String[] segs = normAbs(p).split("/");
        List<String> ns = new ArrayList<>();
        for (String s : segs) if (!s.isEmpty()) ns.add(s);
        return ns.size() > 1 ? ns.get(ns.size() - 2) : "根目录";
    }

    /** 递归扫描一个片源目录，返回视频列表（与服务端 scanLibrary 一致）。
     *  ⚠️ 片库只收 PLAYABLE_EXTS —— 播不了的封装直接跳过不扫（2026-09-19 用户要求，
     *     见 PLAYABLE_EXTS 注释）；ALL_EXTS 只管路径校验（stream / probe / 抽帧）。 */
    public static List<Video> scan(DavClient dav, String startAbs, boolean recursive, int maxDepth) throws Exception {
        return scan(dav, startAbs, recursive, maxDepth, null);
    }

    /**
     * 递归扫描一个片源目录，返回视频列表（与服务端 scanLibrary 一致）。
     * ⚠️ 片库只收 PLAYABLE_EXTS —— 播不了的直接跳过不扫（2026-09-19 用户要求）。
     *
     * @param truncatedOut 长度 ≥1 的数组，回传「是否撞了上限」（可传 null）。
     *   🔴 以前**时间截断完全不报告**（NasServer 只在 `all.size() >= MAX_VIDEOS`
     *   时置 truncated），于是 45 秒一到静悄悄停下，用户以为扫全了 ——
     *   这就是「藏得深的视频扫不出来」最难查的那一半。必须回传。
     */
    public static List<Video> scan(DavClient dav, String startAbs, boolean recursive, int maxDepth,
                                   boolean[] truncatedOut) throws Exception {
        final String root = normAbs(startAbs);
        final List<Video> found = new ArrayList<>();
        final Set<String> visited = new HashSet<>();
        final long t0 = System.currentTimeMillis();
        /* 0 = 不限深度。上限只是防呆（实测真实目录最深 5 层）。
           ⚠️ 原来是 `Math.min(8, ...)` —— 实测 /dav/示例片源 有 48.4% 的视频在第 5 层，
           硬 clamp 到 8 会把更深的全丢掉，而且**不报错**。 */
        final int depthLimit = Math.max(0, Math.min(MAX_DEPTH_CAP, maxDepth));
        final boolean unlimited = depthLimit == 0;
        boolean truncated = false;

        java.util.concurrent.ExecutorService pool =
            java.util.concurrent.Executors.newFixedThreadPool(CONCURRENCY);
        try {
            List<String> frontier = new ArrayList<>();
            frontier.add(root);
            visited.add(root);
            int depth = 1;
            Exception startErr = null;

            while (!frontier.isEmpty()) {
                if (System.currentTimeMillis() - t0 > MAX_MS || found.size() >= MAX_VIDEOS) {
                    truncated = true;
                    android.util.Log.w("NasService", "扫描撞到上限："
                        + found.size() + " 个视频 / " + (System.currentTimeMillis() - t0) + "ms");
                    break;
                }

                /* 并发探这一层（DavClient 只有 final 字段、无共享可变状态，线程安全） */
                List<java.util.concurrent.Future<PropResult>> futs = new ArrayList<>();
                for (final String d : frontier) {
                    futs.add(pool.submit(new java.util.concurrent.Callable<PropResult>() {
                        @Override public PropResult call() {
                            try {
                                return new PropResult(d, dav.propfind(d, "1"), null);
                            } catch (Exception e) {
                                return new PropResult(d, null, e);
                            }
                        }
                    }));
                }

                final List<String> next = new ArrayList<>();
                for (java.util.concurrent.Future<PropResult> f : futs) {
                    PropResult pr;
                    try { pr = f.get(); } catch (Exception ignore) { continue; }
                    if (pr == null) continue;
                    if (pr.items == null) {
                        if (depth == 1 && startErr == null && pr.err != null) startErr = pr.err;
                        else if (pr.err != null) {
                            android.util.Log.w("NasService", "跳过目录 " + pr.dir + " " + pr.err.getMessage());
                        }
                        continue;
                    }
                    /* ⚠️ PROPFIND 的响应里第一条是**目录自己**，必须跳过，
                       否则自己进自己 = 死循环。并发之后只能靠 pr.dir 认。 */
                    final String self = pr.dir.endsWith("/")
                        ? pr.dir.substring(0, pr.dir.length() - 1) : pr.dir;
                    for (DavClient.Entry it : pr.items) {
                        String cp = normAbs(it.href);
                        if (cp.isEmpty()) continue;
                        String name = baseNameOf(cp);
                        if (name.isEmpty() || SKIP_DIR.matcher(name).find()) continue;

                        if (it.isDir) {
                            String norm = cp.endsWith("/") ? cp.substring(0, cp.length() - 1) : cp;
                            if (norm.equals(self)) continue;
                            if (!visited.add(norm)) continue;
                            if (found.size() < MAX_VIDEOS) next.add(norm);
                            continue;
                        }

                        String ext = extOf(name);
                        if (!isPlayableExt(ext)) continue;   // 播不了的（wmv/rmvb/mpg…）直接跳过不进片库（2026-09-19 用户要求）
                        if (found.size() >= MAX_VIDEOS) { truncated = true; continue; }
                        Video v = new Video();
                        v.p = cp; v.name = name; v.size = it.size;
                        v.mtime = it.mtime > 0 ? fmtHttpDate(it.mtime) : "";
                        v.ext = ext; v.playable = isPlayableExt(ext);
                        v.folder = folderOf(cp);
                        String base = name.replaceAll("\\.[^.]+$", "");
                        v.author = v.folder.length() > 12 ? v.folder.substring(0, 12) : v.folder;
                        v.title = base;
                        found.add(v);
                    }
                }

                if (startErr != null) throw startErr;      // 起点目录失败 → 整体失败（跟旧行为一致）
                if (!recursive) break;
                if (!unlimited && depth >= depthLimit) break;
                if (found.size() >= MAX_VIDEOS) { truncated = true; break; }
                frontier = next;
                depth++;
            }
        } finally {
            pool.shutdown();
        }

        if (truncatedOut != null && truncatedOut.length > 0) truncatedOut[0] = truncated;

        Collections.sort(found, new Comparator<Video>() {
            @Override public int compare(Video a, Video b) {
                return a.p.compareToIgnoreCase(b.p);
            }
        });
        return found;
    }

    /**
     * 扫一个**本机目录**，返回视频列表（2026-09-20「本机片源」新增）。
     *
     * 与上面 scan() 的关系：**契约完全一致**（同样的 Video 模型、同样的
     * `truncatedOut` 回传、同样按 p 排序、同样的三道上限），只是枚举手段从
     * 「WebDAV PROPFIND」换成「java.io.File.listFiles()」。
     * 之所以写成两个函数而不是往 scan() 里塞 if：那边整条是**并发 BFS +  Futures**
     * （为 CD2 不支持 Depth:3 才那么绕），本机 File 遍历是**同步递归、毫秒级**，
     * 硬凑进同一个循环只会让两边都难读。
     *
     * @param srcPrefix 写进 Video.p 的**片源前缀**（如 `local:`）。
     *   🔴 必须带前缀：前端拿这个 p 去请求 /api/stream?p=…，后端靠前缀认出
     *      「这是本机的」才走 localAbs 解析。写绝对路径的话前端会把它当 WebDAV 路径。
     * @param rootPrefix 拼 Video.p 时用来把磁盘绝对路径**换回片源坐标**的磁盘根：
     *   p = srcPrefix + "/" + (磁盘路径去掉 rootPrefix 后的相对部分)。
     *   例：rootPrefix=`/…/files/strm`、磁盘文件=`/…/files/strm/云下载/a.strm`
     *       → p = `local:/云下载/a.strm`
     */
    public static List<Video> scanLocal(java.io.File dir, String srcPrefix,
                                        String rootPrefix, boolean recursive, int maxDepth,
                                        boolean[] truncatedOut) {
        final List<Video> found = new ArrayList<>();
        final long t0 = System.currentTimeMillis();
        /* 与 scan() 同一套上限，但本机遍历不会真的撞上 MAX_MS —— 留着是为了
           「行为与 WebDAV 扫描一致」，用户不会遇到两种不同的截断规则。 */
        final int depthLimit = Math.max(0, Math.min(MAX_DEPTH_CAP, maxDepth));
        final boolean unlimited = depthLimit == 0;
        boolean truncated = false;

        /* 广度优先（与 scan() 同序），用队列而不是递归：防深目录把栈打爆，
           而且能就地实现 depthLimit。 */
        java.util.ArrayDeque<Object[]> q = new java.util.ArrayDeque<>();
        q.add(new Object[]{dir, 1});
        String rootAbs = dir.getAbsolutePath();

        while (!q.isEmpty()) {
            if (System.currentTimeMillis() - t0 > MAX_MS || found.size() >= MAX_VIDEOS) {
                truncated = true;
                break;
            }
            Object[] cur = q.poll();
            java.io.File cd = (java.io.File) cur[0];
            int depth = (Integer) cur[1];

            java.io.File[] kids = cd.listFiles();
            if (kids == null) continue;                  // 读不了就当空目录，别让整轮失败

            for (java.io.File f : kids) {
                String nm = f.getName();
                if (SKIP_DIR.matcher(nm).find()) continue;   // 与 WebDAV 扫描同一套跳过规则

                if (f.isDirectory()) {
                    if (!recursive) continue;
                    if (!unlimited && depth >= depthLimit) continue;
                    q.add(new Object[]{f, depth + 1});
                    continue;
                }

                String ext = extOf(nm);
                /* ⚠️ 只收 PLAYABLE_EXTS（与 scan() 一致 —— 片库白名单是统一的；
                   .strm 正在其中，这正是本功能成立的前提）。 */
                if (!isPlayableExt(ext)) continue;

                String abs = f.getAbsolutePath();
                String rel = abs.startsWith(rootAbs)
                    ? abs.substring(rootAbs.length())
                    : "/" + nm;
                String p = srcPrefix + normAbs(rel);

                Video v = new Video();
                v.p = p;
                v.name = nm;
                v.size = f.length();
                v.mtime = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'",
                        java.util.Locale.US)
                        .format(new java.util.Date(f.lastModified()));
                v.ext = ext;
                v.playable = isPlayableExt(ext);
                v.folder = folderOf(p);
                String base = nm.replaceAll("\\.[^.]+$", "");
                v.author = v.folder.length() > 12 ? v.folder.substring(0, 12) : v.folder;
                v.title = base;
                found.add(v);
            }
        }

        if (truncatedOut != null && truncatedOut.length > 0) truncatedOut[0] = truncated;

        Collections.sort(found, new Comparator<Video>() {
            @Override public int compare(Video a, Video b) {
                return a.p.compareToIgnoreCase(b.p);
            }
        });
        return found;
    }

    /** 一次并发 PROPFIND 的结果（带上 dir，好跳过「目录自己」那条） */
    private static final class PropResult {
        final String dir;
        final List<DavClient.Entry> items;
        final Exception err;
        PropResult(String dir, List<DavClient.Entry> items, Exception err) {
            this.dir = dir; this.items = items; this.err = err;
        }
    }

    private static String fmtHttpDate(long ms) {
        java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", java.util.Locale.US);
        f.setTimeZone(java.util.TimeZone.getTimeZone("GMT"));
        return f.format(new java.util.Date(ms));
    }

    /** 组装成前端 applyLibrary 要的 JSON（与服务端 libPayload 对齐） */
    public static JSONObject libraryJson(List<Video> videos, List<String> dirs, long elapsedMs, boolean truncated) {
        JSONObject o = new JSONObject();
        JSONArray arr = new JSONArray();
        try {
            for (Video v : videos) arr.put(v.toJson());
            o.put("videos", arr);
            o.put("scannedAt", System.currentTimeMillis());
            o.put("source", "webdav");
            o.put("cached", false);
            o.put("scanning", false);
            o.put("truncated", truncated);
            o.put("elapsedMs", elapsedMs);
            JSONArray d = new JSONArray();
            for (String s : dirs) d.put(s);
            o.put("dirs", d);
            if (dirs.size() > 0) o.put("dir", dirs.get(0));
        } catch (Exception ignore) {}
        return o;
    }
}
