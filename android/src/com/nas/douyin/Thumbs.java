package com.nas.douyin;

import android.content.Context;
import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 缩略图：抽帧 + 独立目录落盘缓存。
 *
 * 为什么不用 ffmpeg：APK 里没有 ARM ffmpeg（打不进 100MB 的 Windows 版），
 * 而 MediaMetadataRetriever 是 Android 系统自带的解码器，零体积、支持 h264/mp4 这类
 * 主流格式 —— 实测 NAS 上的 1080p h264 mp4 能直接抽到第 60 秒的帧。
 *
 * 为什么单独存目录：缩略图一旦生成就长期保留，不随 App 启动重做。
 * 落盘在 filesDir/thumbs/ 下（不是 cacheDir —— 那个会被系统在存储紧张时清掉），
 * 文件名 = sha1(版本 + 相对路径)，内容换了就靠 bump VER 让旧图失效。
 */
public final class Thumbs {

    private static final String TAG = "Thumbs";

    /**
     * 抽帧逻辑或截取时间点改了就把这个 +1，所有旧缓存自动作废重抽。
     * v1 → v2：改成「多帧选最优」。
     */
    private static final String VER = "v2";

    /** 首选截取点（秒）：跳过片头直接看正片 */
    private static final int SEEK_SEC = 60;
    /** 在首选点抽这么多帧，挑信息量最大的一帧 */
    private static final int CANDIDATES = 3;
    /** 输出宽度（高度按比例）；和 Node 版保持一致 */
    private static final int OUT_W = 320;
    private static final int JPEG_Q = 82;

    /** 判定「废帧」的亮度标准差门槛：黑屏/纯色/过场一般远低于这个值 */
    private static final double MIN_STDDEV = 12.0;

    private final Context ctx;
    private final File dir;

    /** 正在生成的键 → 该任务。用来串行化同名请求，避免重复抽帧 */
    private final Map<String, Object> inflight = new ConcurrentHashMap<>();
    private final Object lock = new Object();

    /**
     * 生成队列：单线程串行。
     * 抽帧要连 NAS 读视频、还要解码，并发几路就会互相抢带宽 ——
     * 点赞通常是一次一个，串行完全够用，也不会把手机拖卡。
     */
    private final ExecutorService queue = Executors.newSingleThreadExecutor(
            new java.util.concurrent.ThreadFactory() {
                @Override
                public Thread newThread(Runnable r) {
                    Thread t = new Thread(r, "thumb-gen");
                    t.setDaemon(true);
                    return t;
                }
            });

    /** 已生成的失败次数：一直失败的别无限重试（比如那个文件 NAS 上已经删了） */
    private final Map<String, Integer> failed = new ConcurrentHashMap<>();
    private static final int MAX_FAIL = 3;

    /**
     * 瞬时失败的重排定时器（**独立于 queue**，见 ensure 里的注释）。
     * 守护线程，进程退出不拖累。
     */
    private final java.util.concurrent.ScheduledExecutorService retryTimer =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "thumb-retry");
                t.setDaemon(true);
                return t;
            });

    /**
     * 🔴 **瞬时可重试**的次数（2026-09-20）。
     *
     * 为什么需要它：App 启动时 HTTP 服务（`new NasServer`）比 CD2 引擎（`startCd2`）**先起来**，
     * 实测两者差 ~680ms —— 这段时间里任何抽帧都会拿到
     * `Failed to connect to /127.0.0.1:19798`（连接被拒）。
     * 旧代码把这当成普通失败 → `failed +1` → 累计 3 次**永久放弃**该视频，
     * 用户看到的就是「点赞列表里永远是 ⚠️ 破图标」。
     *
     * CD2 还会自愈重启、网络也会抖 —— 所以「连不上」值得重试，而且**不该消耗 MAX_FAIL**。
     *
     * 退避：1s → 3s → 6s → 9s → 11s（累计 **30s**，正好覆盖 CD2 冷启动上限
     * `MainActivity.CD2_BOOT_MS`）。**第一次就成功的情况（引擎已就绪）完全不会多等。**
     */
    private final Map<String, Integer> transientFail = new ConcurrentHashMap<>();
    private static final int MAX_TRANSIENT = 5;
    /**
     * 第 n 次重试等的毫秒数：1s、3s、6s、9s、11s → 累计 **30s**，正好覆盖
     * `MainActivity.CD2_BOOT_MS`。
     *
     * ⚠️ 别写成 `1000 << n` 那类指数（1,2,4,8,8…）—— 上限一夹就只有 23s，
     *    **差 7s 盖不住冷启动窗口**，用户会觉得「有时还是没图」。
     *    这个 23 vs 30 的差别是我用脚本模拟退避序列才发现的（肉眼看不出来）。
     */
    private static long transientDelay(int n) {
        switch (n) {
            case 1: return 1_000L;
            case 2: return 3_000L;
            case 3: return 6_000L;
            case 4: return 9_000L;
            default: return 11_000L;
        }
    }

    /** 判断异常是不是「引擎还没起来 / 临时断开」这类**可重试**的错 */
    private static boolean isTransient(Throwable t) {
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof java.net.ConnectException
                    || c instanceof java.net.NoRouteToHostException
                    || c instanceof java.net.UnknownHostException
                    || c instanceof java.net.SocketTimeoutException) return true;
            String m = c.getMessage();
            if (m == null) continue;
            if (m.contains("Failed to connect") || m.contains("Connection refused")
                    || m.contains("ECONNREFUSED") || m.contains("ECONNRESET")) return true;
        }
        return false;
    }

    public Thumbs(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        // 放 filesDir 而不是 cacheDir：cacheDir 会被系统清，缩略图要长期留着
        this.dir = new File(this.ctx.getFilesDir(), "thumbs");
        if (!dir.exists()) dir.mkdirs();
    }

    public File dir() { return dir; }

    /**
     * 一次读出「时长 + 画面尺寸」。给 /api/probe 用。
     *
     * 时长：转码流本身没有时间轴，前端要拿总时长才能把进度条比例换算成目标秒数。
     * 尺寸：**转码流的 video.videoWidth 在 WebView 里恒为 0**（后端封的是
     *   `frag_keyframe+empty_moov` 的 fragmented MP4，moov 是空的、分辨率写在 moof 里，
     *   WebView 能解码但从不回填 videoWidth）。前端要靠这个尺寸去算
     *   `.vbox`（视频真实画面矩形），好让加载转圈对准画面正中而不是整屏中心。
     *
     * ⚠️ 这两个值**必须**被调用方一起缓存（见 NasServer 的 probeCache）——
     * 每探一次都要连一次 NAS 把文件读一段，很贵。
     * 尺寸和时长在同一个 MediaMetadataRetriever 里取，不额外开进程、不额外连 NAS。
     *
     * @return {ms, width, height}；读不到的分量是 0
     */
    public long[] probeMeta(String streamUrl) {
        long[] out = new long[]{0, 0, 0};
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try {
            r.setDataSource(streamUrl, new java.util.HashMap<String, String>());
            String d = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (d != null) { try { long ms = Long.parseLong(d.trim()); if (ms > 0) out[0] = ms; } catch (Throwable ignore) {} }
            // METADATA_KEY_VIDEO_WIDTH/HEIGHT：注意有些机器在没解码首帧前拿不到，
            // 拿不到就是 0，交给 ffprobe 那条路兜底（见 NasServer.probeWithFfprobe）。
            String w = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH);
            String h = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT);
            if (w != null) { try { out[1] = Long.parseLong(w.trim()); } catch (Throwable ignore) {} }
            if (h != null) { try { out[2] = Long.parseLong(h.trim()); } catch (Throwable ignore) {} }
            // ⚠️ 有些容器会把宽高旋转 90° 存（竖屏手机拍的片最常见）：
            //    这里报告的是**存储**尺寸，显示时要靠 rotation 交换宽高。
            //    前端 fitVideoBox 用的是「显示后」的宽高比，所以这里先按 rotation 摆正。
            String rot = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
            if (rot != null && out[1] > 0 && out[2] > 0) {
                try {
                    int deg = Math.abs(Integer.parseInt(rot.trim())) % 180;
                    if (deg == 90) { long t = out[1]; out[1] = out[2]; out[2] = t; }
                } catch (Throwable ignore) {}
            }
        } catch (Throwable t) {
            Log.w(TAG, "读元数据失败 " + t.getMessage());
        } finally {
            try { r.release(); } catch (Throwable ignore) {}
        }
        return out;
    }

    /**
     * 只读时长（毫秒 → 秒）。保留给旧调用点，内部走 probeMeta。
     *
     * @return 秒；读不到返回 0
     */
    public double durationSec(String streamUrl) {
        long[] m = probeMeta(streamUrl);
        return m[0] > 0 ? m[0] / 1000.0 : 0;
    }

    /** 相对路径 → 缓存文件 */
    public File fileFor(String rel) {
        return new File(dir, sha1(VER + ":" + rel) + ".jpg");
    }

    public boolean has(String rel) {
        File f = fileFor(rel);
        return f.isFile() && f.length() > 0;
    }

    /** 已生成的张数 / 目录总字节数，给前端显示用 */
    public long[] stats() {
        File[] fs = dir.listFiles();
        long n = 0, bytes = 0;
        if (fs != null) {
            for (File f : fs) {
                if (f.isFile() && f.getName().endsWith(".jpg")) { n++; bytes += f.length(); }
            }
        }
        return new long[]{n, bytes};
    }

    /**
     * 把某个视频排进生成队列。已经生成过 / 正在生成 / 失败太多次的直接跳过。
     *
     * @param rel     视频相对路径（前端那份 v.p）
     * @param streamUrl 指向本机 /api/stream 的完整 URL（鉴权由本机服务代劳）
     */
    public void ensure(String rel, String streamUrl) {
        if (rel == null || rel.isEmpty()) return;
        if (has(rel)) return;
        if (failed.getOrDefault(rel, 0) >= MAX_FAIL) return;
        if (inflight.containsKey(rel)) return;

        final Object token = new Object();
        inflight.put(rel, token);
        queue.execute(() -> {
            boolean retry = false;
            long delay = 0;
            try {
                if (!has(rel)) generate(rel, streamUrl);
            } catch (Transient e) {
                /* 引擎还没就绪 / 连接被拒 —— **不消耗 MAX_FAIL**，退避后重排 */
                int n = transientFail.merge(rel, 1, Integer::sum);
                if (n <= MAX_TRANSIENT) {
                    retry = true;
                    delay = transientDelay(n);
                    Log.i(TAG, "缩略图稍后重试(" + n + "/" + MAX_TRANSIENT + ") " + rel
                            + " → " + delay + "ms：" + e.getMessage());
                } else {
                    Log.w(TAG, "缩略图重试超限，放弃 " + rel + "：" + e.getMessage());
                    failed.merge(rel, 1, Integer::sum);
                }
            } catch (Throwable t) {
                Log.w(TAG, "抽帧异常 " + rel + " " + t.getMessage());
                failed.merge(rel, 1, Integer::sum);
            } finally {
                inflight.remove(rel);
            }
            if (retry) {
                /* 🔴 重排走**独立的调度器**，不能在 queue 里 Thread.sleep ——
                 * queue 是单线程串行队列，睡在里面会把后面所有抽帧任务一起卡住
                 * （最长 15s）。这一点很隐蔽：功能看起来正常，只是「图出得越来越慢」。 */
                final long d = delay;
                try {
                    retryTimer.schedule(() -> ensure(rel, streamUrl), d, java.util.concurrent.TimeUnit.MILLISECONDS);
                } catch (Throwable ignore) {}
            }
        });
    }

    /**
     * 内部标记：这次失败是「瞬时的」（引擎没就绪 / 连接被拒），值得退避重试。
     * 用异常传递比返回值干净 —— `generate` 里有多层 try/catch，return 容易被吞。
     */
    static final class Transient extends RuntimeException {
        Transient(Throwable cause) { super(cause); }
    }

    /** 真正抽帧：候选点逐个试，选亮度标准差最大的那一帧 */
    private void generate(String rel, String streamUrl) {
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try {
            r.setDataSource(streamUrl, new java.util.HashMap<String, String>());

            long durMs = 0;
            try { durMs = Long.parseLong(nullTo0(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION))); }
            catch (Exception ignore) {}

            // 候选时间点：默认 60s；片子比这短就退到 1/4 处（短片硬 seek 到 60s 会越界抽不到帧）
            long baseUs = durMs > 0
                    ? (durMs >= SEEK_SEC * 1000L ? SEEK_SEC * 1000L : Math.max(1000L, durMs / 4)) * 1000L
                    : SEEK_SEC * 1000_000L;

            List<Long> points = new ArrayList<>();
            for (int i = 0; i < CANDIDATES; i++) {
                // 在基准点附近散开：-5s / 0 / +5s，各自兜住边界
                long d = (i - CANDIDATES / 2) * 5_000_000L;
                long us = baseUs + d;
                if (us < 0) us = 0;
                if (durMs > 0 && us > durMs * 1000L - 200_000L) us = Math.max(0, durMs * 1000L - 200_000L);
                points.add(us);
            }

            Bitmap best = null;
            double bestScore = -1;
            for (long us : points) {
                Bitmap b = null;
                try { b = r.getFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST_SYNC); }
                catch (Throwable ignore) {}
                if (b == null) continue;
                double sd = stddev(b);
                if (sd > bestScore) {
                    if (best != null) best.recycle();
                    best = b;
                    bestScore = sd;
                } else {
                    b.recycle();
                }
                if (bestScore >= MIN_STDDEV * 3) break;   // 已经足够"有内容"，不用看完
            }

            if (best == null) {
                Log.w(TAG, "抽帧失败（没有可用帧） " + rel);
                failed.merge(rel, 1, Integer::sum);
                return;
            }

            // 缩放：只缩宽，高度按比例（-2 的语义 —— 保证偶数，免得某些解码器不喜欢奇数）
            int w = best.getWidth(), h = best.getHeight();
            int outW = Math.min(OUT_W, w);
            int outH = Math.max(2, Math.round((float) h * outW / w));
            outH = outH % 2 == 0 ? outH : outH + 1;
            Bitmap scaled = Bitmap.createScaledBitmap(best, outW, outH, true);
            if (scaled != best) best.recycle();

            File out = fileFor(rel);
            File tmp = new File(dir, out.getName() + ".part");
            try (FileOutputStream os = new FileOutputStream(tmp)) {
                scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_Q, os);
            }
            scaled.recycle();

            if (!tmp.renameTo(out)) {
                // 某些文件系统 rename 会失败，退化成复制
                java.io.FileInputStream in = new java.io.FileInputStream(tmp);
                FileOutputStream os = new FileOutputStream(out);
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                in.close(); os.close();
                tmp.delete();
            }
            Log.i(TAG, "缩略图已生成 " + out.getName() + " (" + outW + "x" + outH + ", sd=" + Math.round(bestScore) + ")");
        } catch (Throwable t) {
            /* 引擎还没起来 / 连接被拒 → 交给 ensure 退避重试，**不消耗 MAX_FAIL** */
            if (isTransient(t)) throw new Transient(t);
            Log.w(TAG, "抽帧失败 " + rel + " " + t);
            failed.merge(rel, 1, Integer::sum);
        } finally {
            try { r.release(); } catch (Throwable ignore) {}
        }
    }

    /** 采样若干像素算亮度标准差：越大说明画面越"有东西" */
    private static double stddev(Bitmap b) {
        int step = Math.max(1, Math.min(b.getWidth(), b.getHeight()) / 16);
        long sum = 0, sum2 = 0;
        int n = 0;
        for (int y = step / 2; y < b.getHeight(); y += step) {
            for (int x = step / 2; x < b.getWidth(); x += step) {
                int p = b.getPixel(x, y);
                int lum = (int) (0.299 * ((p >> 16) & 0xFF) + 0.587 * ((p >> 8) & 0xFF) + 0.114 * (p & 0xFF));
                sum += lum; sum2 += (long) lum * lum; n++;
            }
        }
        if (n == 0) return 0;
        double mean = (double) sum / n;
        return Math.sqrt(Math.max(0, (double) sum2 / n - mean * mean));
    }

    private static String nullTo0(String s) { return s == null ? "0" : s; }

    private static String sha1(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] d = md.digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte x : d) sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }
}
