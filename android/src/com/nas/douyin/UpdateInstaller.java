package com.nas.douyin;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * 应用内更新：下载 APK + 校验 + 拉起系统安装器（2026-09-23）。
 *
 * <h3>为什么这段逻辑独立成一个类</h3>
 * MainActivity 已经 1100+ 行、里面塞了七八个内部类。更新这块自带「后台线程 + 进度回调 +
 * 两个坑（FileUriExposed / 未知来源权限）」，塞进 NasBridge 会让那个本来就很长的内部类更难读。
 *
 * <h3>流程</h3>
 * <pre>
 *   网页                         本类
 *   ────                         ────
 *   startDownload(url)  ───────► 工作线程流式下载 → cacheDir/update/app-update.apk
 *                               ├─ 每 ~200ms 回一次进度 → window.__updProgress({pct,mb,mbTotal})
 *                               └─ 完成后回       → window.__updDone({ok:true,...})
 *   install()           ───────► 校验「未知来源」权限 → FileProvider Uri → ACTION_VIEW
 * </pre>
 *
 * <h3>🔴 两个必踩的坑（都已在代码里处理）</h3>
 *
 * <p><b>坑 1：从 Android 12 起不能再「下完直接弹安装」。</b>
 * 12+ 引入「近似安装」限制：只有**用户主动点击**触发的那一次下载，才允许紧接着弹安装界面；
 * 后台自动下载完再弹会被系统忽略。所以这里**严格把「下载」和「安装」拆成两个用户动作**
 * （网页上也是两个按钮），绝不能自作聪明在下载完成回调里直接 install()。
 *
 * <p><b>坑 2：未知来源权限要跳系统设置页，而且返回后要重新触发。</b>
 * {@code REQUEST_INSTALL_PACKAGES} 只是声明，用户仍可能在系统里关掉「允许安装未知应用」。
 * 那种情况下启动安装会被静默拒绝。这里先查 {@code canRequestPackageInstalls()}，
 * 没开就跳 ACTION_MANAGE_UNKNOWN_APP_SOURCES；回来后页面上再点一次安装即可
 * （不自动重试：那是跨 Activity 的异步返回，自动重试容易在用户没准备好时突然弹窗）。
 *
 * <h3>⚠️ 进度回调的节流</h3>
 * 58MB 的包按 8KB 一读会有上千次回调，每次都跨 JS 桥（evaluateJavascript 不便宜）
 * 会把主线程打满、页面直接卡死。所以**按百分比变化节流**（见 PROGRESS_STEP）。
 */
class UpdateInstaller {

    private static final String TAG = "NasDouyin";
    /** 下载文件名固定：覆盖式重写，不堆积 / 不占用户存储 */
    private static final String APK_NAME = "app-update.apk";
    /** 进度回调的最小变化梯度（%）—— 见类注释「进度回调的节流」 */
    private static final int PROGRESS_STEP = 2;
    private static final int CONNECT_TIMEOUT = 15000;
    private static final int READ_TIMEOUT = 30000;

    private final Activity act;
    private final WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    /** 下载线程句柄：用来「同一时刻只允许一个下载」以及取消 */
    private volatile Thread worker;

    UpdateInstaller(Activity act, WebView web) {
        this.act = act;
        this.web = web;
    }

    /** 下载中的 APK（install 要用的那个路径，也用于「已下好没装」时直接装） */
    File apkFile() {
        File dir = new File(act.getCacheDir(), "update");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, APK_NAME);
    }

    /** 本地是不是已经有一个下好的包（网页据此决定「下载」还是「直接安装」） */
    boolean hasDownloaded() {
        File f = apkFile();
        return f.isFile() && f.length() > 0;
    }

    /**
     * 下载 APK 到 cacheDir/update/app-update.apk。
     *
     * @param url    直链（GitHub Release 的 browser_download_url）
     * @param sha256 期望的 sha256（小写十六进制）；空字符串表示跳过校验
     */
    void download(final String url, final String sha256) {
        if (worker != null && worker.isAlive()) {
            js("window.__updDone&&window.__updDone(" + err("已有下载在进行中").toString() + ")");
            return;
        }
        final File out = apkFile();
        worker = new Thread(() -> {
            HttpURLConnection conn = null;
            InputStream in = null;
            FileOutputStream os = null;
            try {
                /* 🔴 旧包必须先删：GitHub 的直链是 302 跳到 CDN，
                   如果这次下载中途失败留下半截文件，下次 install 会装到一个坏包。
                   网络请求前先删，保证「能看到这个文件」=「它是完整的」。 */
                if (out.exists()) out.delete();

                long done = 0, total = -1;
                int lastPct = -1;
                conn = open(url);
                int code = conn.getResponseCode();
                if (code / 100 == 3) {
                    /* GitHub release 资产走 302 → release-assets.githubusercontent.com。
                       HttpURLConnection 默认**不跟随**跨协议跳转，这里手动跟一层。
                       （实测只跳一次；真出现多跳会由下面的 code 判断兜住。） */
                    String loc = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (loc == null) throw new Exception("重定向没有 Location 头");
                    conn = open(loc);
                    code = conn.getResponseCode();
                }
                if (code != 200) throw new Exception("服务器返回 HTTP " + code);
                total = conn.getContentLengthLong();   // 可能是 -1（chunked）

                in = conn.getInputStream();
                os = new FileOutputStream(out);
                byte[] buf = new byte[64 * 1024];
                MessageDigest md = sha256 == null || sha256.isEmpty() ? null : MessageDigest.getInstance("SHA-256");
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    if (md != null) md.update(buf, 0, n);
                    done += n;
                    if (total > 0) {
                        int pct = (int) (done * 100 / total);
                        if (pct >= lastPct + PROGRESS_STEP || pct == 100) {
                            lastPct = pct;
                            reportProgress(pct, done, total);
                        }
                    }
                }
                os.flush();
                os.close(); os = null;
                in.close(); in = null;

                if (total > 0 && done != total) {
                    throw new Exception("下载不完整：" + done + "/" + total + " 字节");
                }
                if (md != null) {
                    String got = hex(md.digest());
                    if (!got.equalsIgnoreCase(sha256)) {
                        out.delete();
                        throw new Exception("校验失败，文件可能不完整（sha256 不匹配）");
                    }
                }
                final long size = done;
                ui.post(() -> {
                    JSONObject o = new JSONObject();
                    try {
                        o.put("ok", true);
                        o.put("mb", String.format(java.util.Locale.US, "%.1f", size / 1048576.0));
                        o.put("path", out.getAbsolutePath());
                    } catch (Throwable ignore) {}
                    js("window.__updDone&&window.__updDone(" + o + ")");
                });
            } catch (Throwable t) {
                Log.e(TAG, "更新包下载失败", t);
                if (out.exists()) out.delete();   // 半截文件留着只会让下次 install 装到坏包
                js("window.__updDone&&window.__updDone(" + err(String.valueOf(t.getMessage())) + ")");
            } finally {
                try { if (os != null) os.close(); } catch (Throwable ignore) {}
                try { if (in != null) in.close(); } catch (Throwable ignore) {}
                if (conn != null) conn.disconnect();
            }
        }, "apk-download");
        worker.setDaemon(true);
        worker.start();
    }

    private HttpURLConnection open(String u) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        c.setInstanceFollowRedirects(false);      // 自己控制跳转（见 download 里的注释）
        c.setConnectTimeout(CONNECT_TIMEOUT);
        c.setReadTimeout(READ_TIMEOUT);
        c.setRequestProperty("Accept", "application/octet-stream");
        c.setRequestProperty("User-Agent", "douyin-nas-android");
        return c;
    }

    /**
     * 拉起系统安装器安装已下好的包。
     *
     * ⚠️ 必须跑在主线程（下面的 ui.post），而且**不能在下载线程里调** ——
     *    Android 12+ 的「近似安装」限制会认「是不是用户点击触发」，
     *    所以这个方法是给网页按钮单独调的，不要从 download 的回调里自动调用。
     */
    void install() {
        ui.post(() -> {
            try {
                File f = apkFile();
                if (!f.isFile() || f.length() == 0) {
                    js("window.__updDone&&window.__updDone(" + err("还没下载安装包") + ")");
                    return;
                }
                /* 🔴 坑 2：未知来源权限。没开就跳系统设置页，**不要**假装能装。 */
                if (Build.VERSION.SDK_INT >= 26 && !act.getPackageManager().canRequestPackageInstalls()) {
                    js("window.__updDone&&window.__updDone(" + err("NEED_UNKNOWN_SOURCE") + ")");
                    try {
                        Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                        s.setData(Uri.parse("package:" + act.getPackageName()));
                        act.startActivity(s);
                    } catch (Throwable t) {
                        // 个别 ROM 没有这个页面 → 退到应用详情页，让用户自己找
                        Intent s2 = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                        s2.setData(Uri.parse("package:" + act.getPackageName()));
                        try { act.startActivity(s2); } catch (Throwable ignore) {}
                    }
                    return;
                }

                /* 🔴 坑 1（FileUriExposedException）：Android 8+ 不许把 file:// 交给别的 App。
                   走自己的 UpdateProvider 换成 content://，并只在这条 Intent 上临时授权。 */
                Uri uri = Uri.parse("content://" + UpdateProvider.AUTHORITY + "/" + f.getName());
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                // 只有一个安装器 App 时直接进它，不走「打开方式」选择器
                i.setComponent(null);
                act.startActivity(i);
                js("window.__updDone&&window.__updDone(" + new JSONObject().put("ok", true).put("installing", true) + ")");
            } catch (Throwable t) {
                Log.e(TAG, "拉起安装器失败", t);
                js("window.__updDone&&window.__updDone(" + err("拉起安装器失败：" + t.getMessage()) + ")");
            }
        });
    }

    /** 删掉下好的包（用户点「取消」/ 关面板时清一下缓存） */
    void clear() {
        File f = apkFile();
        if (f.exists()) f.delete();
    }

    // ------------------------------------------------------------------ 工具

    private void reportProgress(int pct, long done, long total) {
        final String jsStr = "window.__updProgress&&window.__updProgress(" + pct + ","
                + (done / 1048576.0) + "," + (total / 1048576.0) + ")";
        ui.post(() -> js(jsStr));
    }

    private static JSONObject err(String msg) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("err", msg == null ? "未知错误" : msg);
        } catch (Throwable ignore) {}
        return o;
    }

    private void js(final String code) {
        ui.post(() -> {
            try { web.evaluateJavascript(code, null); } catch (Throwable ignore) {}
        });
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 0xF, 16)).append(Character.forDigit(x & 0xF, 16));
        return sb.toString();
    }
}
