package com.nas.douyin;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;

/**
 * 一个「壳」：全屏 WebView 加载跑在电脑/群晖上的 douyin-nas 服务。
 *
 * 后端（WebDAV 代理 + ffmpeg 转码）必须待在能访问 NAS 的那台机器上，
 * 所以 App 这边只负责把网页装进一个没有地址栏、没有浏览器按钮的窗口里。
 *
 * 服务器地址存在 SharedPreferences，默认值由 build.js 注入（见 res/values/build_default.xml）。
 */
public class MainActivity extends Activity {

    private static final String TAG = "NasDouyin";
    private static final String PREFS = "nasdy";
    private static final String KEY_URL = "server";
    private static final int LOAD_TIMEOUT_MS = 12000;

    private FrameLayout root;
    private View webHolder;
    private WebView web;
    private ProgressBar spin;
    private ScrollView setup;
    private EditText urlInput;
    private EditText userInput;
    private EditText passInput;
    private EditText dirsInput;
    private TextView setupStatus;

    private Chrome chrome;
    private View customView;                       // 视频全屏时挂上来的 SurfaceView
    private boolean pageLoaded = false;
    private AlertDialog backMenu;                  // 返回键兜底菜单（防连按叠层，见 showBackMenu）

    private NasServer nas;                         // 内嵌本地 HTTP 服务（手机自己当后端）
    private static final int LOCAL_PORT = 8099;    // WebView 访问的本地端口

    private final Handler ui = new Handler(Looper.getMainLooper());
    private Runnable timeout;

    private static final int REQ_PLAYER = 77;
    /** 网页文件选择器（换头像）的请求码，onActivityResult 里分开处理 */
    private static final int REQ_FILE = 78;
    /** Chrome.onShowFileChooser 交给我们的回调，选完（或取消）必须回一次，否则网页端会卡 */
    private android.webkit.ValueCallback<Uri[]> fileCallback;

    // ---- 内置 CloudDrive2（手机本地的网盘服务引擎，实现见类末尾那一节）----
    /** 它的 WebDAV / 管理页端口（config.toml 钉死）；App 的 WebDAV 客户端连 `http://127.0.0.1:19798/dav` */
    static final int CD2_PORT = 19798;
    /** 等它起来的上限：首次要建库，实测 3~8 秒，给足余量 */
    private static final int CD2_BOOT_MS = 30000;

    private Process cd2Proc;
    private volatile boolean cd2Ready = false;
    /** 起不来时给前端看的原因（空 = 没出错） */
    private volatile String cd2BootError;
    /** 上次**尝试**启动的时间戳 —— cd2Status 里的自愈重启用它做节流 */
    private volatile long cd2LastStartMs = 0;
    private final Object cd2Lock = new Object();

    /**
     * 当前是不是浅色主题（2026-09-21，配合网页的深色/浅色切换）。
     * 网页换主题时会通过 NasBridge.setTheme 推过来，这里记一份 —— 因为
     * applyImmersive(false)（退出全屏播放）会把整个 systemUiVisibility 重置掉，
     * 不记的话退出全屏后状态栏图标又变回白的、压在浅底上看不见。
     */
    private boolean lightTheme = false;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_main);

        root = findViewById(R.id.root);
        webHolder = findViewById(R.id.webHolder);
        web = findViewById(R.id.web);
        spin = findViewById(R.id.spin);
        setup = findViewById(R.id.setup);
        urlInput = findViewById(R.id.urlInput);
        userInput = findViewById(R.id.userInput);
        passInput = findViewById(R.id.passInput);
        dirsInput = findViewById(R.id.dirsInput);
        setupStatus = findViewById(R.id.setupStatus);

        // 看片时别让屏幕自动灭
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                   // 前端用 localStorage 存偏好
        // ⚠️ 不要开 setDatabaseEnabled(true)：WebKit 时代的 WebSQL 遗留开关，
        //    Chromium WebView 上已废弃，且在部分 MIUI 机型上会干扰渲染进程的创建。
        //    前端只用 localStorage（由 DomStorage 提供），不依赖 WebSQL。
        //    2026-09-18 真机排查时去掉。
        s.setMediaPlaybackRequiresUserGesture(false);   // 否则自动播放要用户先点一下
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) s.setSafeBrowsingEnabled(false);
        s.setUserAgentString(s.getUserAgentString() + " NasDouyin/2.0");

        CookieManager.getInstance().setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) WebView.setWebContentsDebuggingEnabled(true);

        web.setBackgroundColor(Color.BLACK);
        chrome = new Chrome();
        web.setWebViewClient(new Client());
        web.setWebChromeClient(chrome);

        // 原生桥：让网页直接控制 Activity 的方向 / 全屏等系统能力。
        web.addJavascriptInterface(new NasBridge(), "NasBridge");

        // 起本地后端（手机自己当服务器，替代电脑）
        nas = new NasServer(this);
        // 内置 CloudDrive2 引擎（手机本地的网盘服务）：App 一启动就拉起，
        // 它自己在本机 127.0.0.1:19798 提供 WebDAV + 管理页，彻底不再内置 Alist
        //（Alist 打 115 风控太频繁；CD2 引擎模拟官方客户端协议，风控最少）。
        startCloudDrive2();
        nas.loadConfig();
        try {
            nas.start(LOCAL_PORT);
        } catch (Exception e) {
            Log.e(TAG, "本地服务起不来", e);
        }

        findViewById(R.id.btnConnect).setOnClickListener(v -> connect());
        dirsInput.setOnEditorActionListener((v, actionId, ev) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                connect();
                return true;
            }
            return false;
        });

        // 回填上次的 WebDAV 配置（键名同 connect()，见那里的注释）
        SharedPreferences p = prefs();
        urlInput.setText(p.getString("url", ""));
        userInput.setText(p.getString("user", ""));
        passInput.setText(p.getString("pass", ""));
        dirsInput.setText(splitDirs(p.getString("dirs", "")));

        load("http://127.0.0.1:" + LOCAL_PORT + "/");
    }

    // ---------------------------------------------------------------- 地址

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** 用户可能只敲了 192.168.1.7:8080，补成完整 URL */
    static String normalize(String raw) {
        if (raw == null) return null;
        String u = raw.trim();
        if (u.isEmpty()) return null;
        if (!u.matches("(?i)^https?://.*")) u = "http://" + u;
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    /** 只留 host:port 用于报错文案，别把整条 URL 摊给用户看 */
    private static String hostOf(String url) {
        try {
            String a = Uri.parse(url).getAuthority();
            return a != null ? a : url;
        } catch (Throwable t) {
            return url;
        }
    }

    /**
     * 首页那个框用户是拿逗号分隔多个文件夹写的，但 NasServer 存的是 \u0001 分隔
     * （因为 NAS 上的路径本身可能带逗号）。这里做一次转换。
     */
    static String joinDirs(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (String d : raw.split(",")) {
            String t = d.trim();
            if (t.isEmpty()) continue;
            if (sb.length() > 0) sb.append('\u0001');
            sb.append(t);
        }
        return sb.toString();
    }

    /** joinDirs 的逆运算，用于把配置回填到输入框 */
    static String splitDirs(String stored) {
        if (stored == null || stored.isEmpty()) return "";
        return String.join(",", stored.split("\u0001"));
    }

    private void connect() {
        String u = normalize(urlInput.getText().toString());
        if (u == null) {
            toast("请先填写群晖 WebDAV 地址（如 http://192.168.1.100:5005）");
            return;
        }
        // 保存 WebDAV 配置到本地。
        // ⚠️ 键名必须和 NasServer.loadConfig() 读的那四个一字不差（url / user / pass / dirs）——
        //    两边共用 "nasdy" 这个 SharedPreferences 文件，但历史上前端写的是 "dav_xxx" 前缀，
        //    后端读的是无前缀的键，**中间没有任何桥接代码**，导致首页这个表单填了等于没填。
        //    2026-09-18 真机验收时发现并修正。
        prefs().edit()
                .putString("url", u)
                .putString("user", userInput.getText().toString().trim())
                .putString("pass", passInput.getText().toString())
                // dirs 在 NasServer 里是用 \u0001 分隔的（路径里可能有逗号），不能直接存用户输入的逗号串
                .putString("dirs", joinDirs(dirsInput.getText().toString().trim()))
                .apply();
        nas.loadConfig();
        hideSetup();
        load("http://127.0.0.1:" + LOCAL_PORT + "/");
    }

    private void load(String url) {
        pageLoaded = false;
        spin.setVisibility(View.VISIBLE);
        web.setVisibility(View.VISIBLE);
        armTimeout();
        Log.i(TAG, "load " + url);
        web.loadUrl(url);
    }

    private void armTimeout() {
        cancelTimeout();
        timeout = () -> {
            if (!pageLoaded) diagnoseAndShowSetup();
        };
        ui.postDelayed(timeout, LOAD_TIMEOUT_MS);
    }

    /**
     * 页面超时没加载出来时，**先自检本机服务**，再决定该说什么。
     *
     * 为什么不能直接喊「连不上」：本机 8099 是我们自己起的服务，用 curl 打
     * http://127.0.0.1:8099/ 常常是 200 且 10ms 内就回。真正的病因往往是
     * **WebView 的渲染进程起不来**（Chromium 渲染进程是 isolated 进程，
     * 依赖系统的 cgroup 配置；系统 /dev/blkio 挂载丢了就创建不了，
     * 详见 skill §28）。这时如果提示「连不上 / 地址端口对不对」，
     * 会把用户往完全错误的方向带。
     *
     * 所以在 IO 线程上打一下本机服务：
     *   通了 → 问题在 WebView，把病因说清楚；
     *   没通 → 才是真的服务没起来。
     */
    private void diagnoseAndShowSetup() {
        // /api/config 是 GET 就回一小段 JSON，最轻量，拿来当「服务活着吗」的探针
        final String self = "http://127.0.0.1:" + LOCAL_PORT + "/api/config";
        new Thread(() -> {
            String verdict = null;
            try {
                java.net.HttpURLConnection c =
                        (java.net.HttpURLConnection) new java.net.URL(self).openConnection();
                c.setConnectTimeout(3000);
                c.setReadTimeout(3000);
                int code = c.getResponseCode();
                c.disconnect();
                // 只要能拿到任何 HTTP 响应（哪怕 4xx），就说明本机服务是活的
                if (code > 0) verdict = "browser";
            } catch (Exception e) {
                Log.w(TAG, "自检本机服务失败: " + e.getMessage());
            }
            final String v = verdict;
            ui.post(() -> {
                if (v == null) {
                    // 本机服务都打不通 —— 这才是真的起不来
                    showSetup(hostOf(web.getUrl() == null ? "" : web.getUrl()) + " 页面没加载出来");
                    setupStatus.setText(
                            "本机服务也没起来，可能是端口被占或启动失败。\n" +
                            "按返回键 → 服务器设置，检查地址；或重启 App 再试。");
                } else {
                    // 🔴 服务是好的 → 100% 是 WebView 的问题，直接说清
                    showSetup(hostOf(web.getUrl() == null ? "" : web.getUrl()) + " 网页渲染不出来");
                    setupStatus.setText(
                            "服务器地址没问题，本机服务是通的。\n" +
                            "问题在手机的 WebView（网页渲染进程起不来），重装 App 没用。\n" +
                            "常见原因：系统的 /dev/blkio cgroup 挂载丢失。\n" +
                            "试试：① 重启手机（首选）② 更新/重装 Android System WebView\n" +
                            "③ 开发者选项里换一个「WebView 实现」。");
                }
            });
        }, "self-check").start();
    }

    private void cancelTimeout() {
        if (timeout != null) {
            ui.removeCallbacks(timeout);
            timeout = null;
        }
    }

    // ------------------------------------------------------------ 设置界面

    private void showSetup(String err) {
        spin.setVisibility(View.GONE);
        if (err != null && !err.isEmpty()) {
            setupStatus.setText(err + "\n确认手机与群晖在同一网络，地址端口正确");
            setupStatus.setVisibility(View.VISIBLE);
        } else {
            setupStatus.setVisibility(View.GONE);
        }
        if (setup.getVisibility() != View.VISIBLE) {
            setup.setVisibility(View.VISIBLE);
            urlInput.requestFocus();
            urlInput.setSelection(urlInput.getText().length());
        }
    }

    private void hideSetup() {
        setup.setVisibility(View.GONE);
        setupStatus.setVisibility(View.GONE);
    }

    private void toast(String m) {
        Toast.makeText(this, m, Toast.LENGTH_SHORT).show();
    }

    // ---------------------------------------------------------------- 返回键

    @Override
    public void onBackPressed() {
        if (customView != null) {          // 全屏播放中，先退出全屏
            chrome.onHideCustomView();
            return;
        }
        /* 🔴 先问页面一次（2026-09-20）：页面里可能盖着浮层、或者在文件夹里还能退回上一级。
         *
         * 为什么不能像以前那样**无条件弹菜单**：`sheetOpen`（哪个面板开着）、
         * `B.info`（文件夹当前层）这些状态全在 WebView 里，Java 侧看不见 ——
         * 用户在文件夹里按返回键，等的是「退回上一级」，结果弹出一个菜单，
         * 观感就是「返回键坏了」。
         *
         * 约定：`window.__onBack()` 返回 true = 页面自己消化掉了这次返回；
         *       返回 false / 页面还没加载好 / JS 抛错 → 走下面那句 showBackMenu()。
         * ⚠️ 必须用 evaluateJavascript 的**回调**（异步），回调在 UI 线程上跑，
         *    直接 showDialog 是安全的。 */
        if (web == null) { showBackMenu(); return; }
        web.evaluateJavascript(
                "(function(){try{return !!(window.__onBack&&window.__onBack());}"
                        + "catch(e){return false;}})()",
                value -> {
                    if ("true".equals(value)) return;   // 页面自己处理了，别弹菜单
                    showBackMenu();
                });
    }

    /** 页面没接住返回键时的兜底菜单（重新加载 / 服务器设置 / 退出） */
    private void showBackMenu() {
        /* 连按返回键会叠出两个菜单（evaluateJavascript 是异步的，第二次返回键
           可能在第一次的回调之前就发出去了）—— 已经开着就别再开一个。 */
        if (backMenu != null && backMenu.isShowing()) return;
        backMenu = new AlertDialog.Builder(this)
                .setTitle(R.string.app_name)
                .setItems(new CharSequence[]{
                        getString(R.string.menu_reload),
                        getString(R.string.menu_server),
                        getString(R.string.menu_exit),
                }, (d, which) -> {
                    if (which == 0) {
                        web.reload();
                    } else if (which == 1) {
                        showSetup(null);
                    } else {
                        finish();
                    }
                })
                .setNegativeButton(R.string.menu_cancel, null)
                .show();
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK) {
            onBackPressed();
            return true;
        }
        return super.onKeyDown(code, e);
    }

    // ------------------------------------------------------------ WebView 回调

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            return false;                // 一律留在 App 内，不甩给系统浏览器
        }

        @Override
        public void onPageFinished(WebView v, String url) {
            pageLoaded = true;
            cancelTimeout();
            spin.setVisibility(View.GONE);
        }

        @Override
        public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
            if (!r.isForMainFrame()) return;          // 某个接口失败不影响页面本身
            pageLoaded = false;
            cancelTimeout();
            spin.setVisibility(View.GONE);
            showSetup("连不上 " + hostOf(r.getUrl().toString()));
        }

        @Override
        public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse resp) {
            if (!r.isForMainFrame()) return;
            int code = resp == null ? 0 : resp.getStatusCode();
            if (code >= 400) {
                pageLoaded = false;
                cancelTimeout();
                spin.setVisibility(View.GONE);
                showSetup(hostOf(r.getUrl().toString()) + " 返回了 " + code);
            }
        }

        /**
         * 渲染进程挂掉时才会走到这里。
         *
         * 为什么必须有这个回调：WebView 的渲染进程（Chromium 的 sandboxed / isolated
         * 进程）如果起不来或中途被杀，**onPageFinished / onReceivedError 一个都不会触发**，
         * 页面就那么一直白/黑着，只能靠 LOAD_TIMEOUT_MS 到点兜底——而兜底提示写的是
         * 「连不上 <当前 URL>」，会让人误以为是网络/服务端的问题。
         *
         * 2026-09-18 真机（MIX 2S）排查就是这个症状：本机 8099 用 curl 打 8~15ms 就 200，
         * 但 WebView 死活不触发 onPageFinished。查 logcat 才看到 system_server 反复报
         *   E ZygoteProcess: Starting VM process through Zygote failed
         * 即 zygote fork 不出渲染进程。属于设备层面的问题，App 能做的是**说清病因**。
         *
         * 返回 true 表示「这个 WebView 已经废了，别再往下走」，然后重建一个继续用。
         */
        @Override
        public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
            boolean crashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && d != null && d.didCrash();
            Log.e(TAG, "渲染进程没了 crashed=" + crashed + "（大概率是系统 fork 不出沙箱进程）");
            pageLoaded = false;
            cancelTimeout();
            spin.setVisibility(View.GONE);
            showSetup(crashed ? "网页渲染进程崩溃了" : "网页渲染进程被系统回收了");
            setupStatus.setText(
                    "这是手机系统的问题，不是服务器地址填错：\n" +
                    "• 本机服务其实正常（用 curl 打 http://127.0.0.1:8099/ 能秒回 200）\n" +
                    "• 真凶通常是 WebView 的渲染进程起不来（logcat 里会有\n" +
                    "  「ZygoteProcess: Starting VM process through Zygote failed」）\n" +
                    "• 先试：重启手机；还不行就更新/重装 Android System WebView\n" +
                    "• 或在开发者选项里把「WebView 实现」切成另一个版本试试");
            return true;   // 告诉框架：这个实例已经不可用了，调用方负责重建
        }
    }

    /** 网页可调用的原生能力。setOrientation 让全屏播放器像抖音那样强制横屏。 */
    private class NasBridge {
        @android.webkit.JavascriptInterface
        public void setOrientation(String mode) {
            final int o;
            if ("landscape".equals(mode)) o = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
            else if ("portrait".equals(mode)) o = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
            else o = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;   // 交给传感器
            ui.post(() -> setRequestedOrientation(o));
        }

        /**
         * 网页换了主题（深色 / 浅色）时同步系统栏配色（2026-09-21）。
         * 网页在**每次 applyTheme 时**都会推一次 —— 不只是用户点切换时，
         * 这样 App 重启后带着浅色配置进来也能立刻把状态栏改对。
         * ⚠️ 参数只认 "light"，其余一律按深色处理（和网页侧 themeResolved 的取值对齐）。
         */
        @android.webkit.JavascriptInterface
        public void setTheme(String theme) {
            final boolean light = "light".equals(theme);
            ui.post(() -> {
                lightTheme = light;
                applySystemBarTheme(light);
            });
        }

        /**
         * 系统当前是深色还是浅色（返回 "dark" / "light"）。
         *
         * 🔴 为什么非要绕到原生：**Android WebView 的 {@code prefers-color-scheme}
         *    取自 App 自己的主题**（本项目是 {@code Theme.Material.NoActionBar} 深色主题），
         *    跟系统设置毫无关系 —— 实测把系统切成浅色，网页里
         *    {@code matchMedia('(prefers-color-scheme: light)').matches} 依然是 false。
         *    也就是说只靠媒体查询的话，「跟随系统」这一档会**永远停在深色**，
         *    是个假的档位。所以由原生读系统的 uiMode 再告诉网页。
         */
        @android.webkit.JavascriptInterface
        public String systemTheme() {
            return isSystemDark() ? "dark" : "light";
        }

        /**
         * 拉起原生全屏播放器（系统硬解，不经过 WebView）。
         * url 直连流、enc 重编码流（直连播不动时兜底）、posSec 起始秒、path 用于回传位置。
         */
        @android.webkit.JavascriptInterface
        public void openPlayer(String url, String enc, String title, int posSec, String path) {
            ui.post(() -> {
                try {
                    Intent i = new Intent(MainActivity.this, PlayerActivity.class);
                    i.putExtra(PlayerActivity.EX_URL, url == null ? "" : url);
                    i.putExtra(PlayerActivity.EX_ENC, enc == null ? "" : enc);
                    i.putExtra(PlayerActivity.EX_TITLE, title == null ? "" : title);
                    i.putExtra(PlayerActivity.EX_POS, posSec);
                    i.putExtra(PlayerActivity.EX_PATH, path == null ? "" : path);
                    startActivityForResult(i, REQ_PLAYER);
                } catch (Throwable t) {
                    Log.e(TAG, "打开原生播放器失败", t);
                }
            });
        }

        /**
         * 重启整个应用 —— 首页左上角那个按钮（2026-09-19 加）。
         *
         * 用 recreate() 而**不是**杀进程，理由是本地服务：
         *   · `NasServer` 是在 onCreate 里 `new` + `start(8099)` 的，
         *     recreate 会完整走一遍 onDestroy（那里已有 `nas.stop()`，放开 8099 端口）
         *     → onCreate（重新 new + start），所以**不会端口冲突**；
         *   · 真要杀进程（Process.killProcess）得靠 AlarmManager 再把自己拉起来，
         *     否则用户被退回桌面；而 setExact 在 Android 12+ 还要额外权限 —— 不值得。
         */
        @android.webkit.JavascriptInterface
        public void restartApp() {
            ui.post(() -> {
                try {
                    recreate();
                } catch (Throwable t) {
                    Log.e(TAG, "重启应用失败", t);
                }
            });
        }

        /* ==================== 应用内更新（2026-09-23） ====================
         *
         * 网页侧「设置 → 版本更新」整套流程都走这三个方法：
         *   updDownload(url, sha256) → 工作线程下载到 cacheDir/update/app-update.apk
         *   updInstall()             → 拉起系统安装器
         *   updClear()               → 删掉下好的包
         *
         * 🔴 为什么下载和安装**必须分成两次用户点击**（不能下完自动装）：
         *    Android 12+ 的「近似安装」限制只认「用户主动点击触发」的那一次，
         *    后台下载完自动弹安装会被系统静默忽略。所以这里坚决不自动串联，
         *    详见 UpdateInstaller 的类注释。
         *
         * 🔴 为什么非要有原生参与（不能像网页版那样 <a download>）：
         *    WebView 里既没有写「下载」目录的权限，也**不能**自己拉安装器 ——
         *    安装器要的是 `content://` Uri，只有原生能通过 provider 生成。
         */

        private UpdateInstaller updater;

        private UpdateInstaller updater() {
            if (updater == null) updater = new UpdateInstaller(MainActivity.this, web);
            return updater;
        }

        /**
         * 下载更新包。url 来自 GitHub Release 的 browser_download_url；
         * sha256 为空表示跳过校验（理论上不会，网页侧会带上）。
         */
        @android.webkit.JavascriptInterface
        public void updDownload(String url, String sha256) {
            updater().download(url, sha256);
        }

        /** 安装已下好的包（用户点「安装」时才调；会先查「未知来源」权限） */
        @android.webkit.JavascriptInterface
        public void updInstall() {
            updater().install();
        }

        /** 清掉下好的包（用户在面板里点「取消」或重启流程时调） */
        @android.webkit.JavascriptInterface
        public void updClear() {
            updater().clear();
        }

        /** 本地是否已有下好的包 —— 网页据此决定按钮显示「下载」还是「安装」 */
        @android.webkit.JavascriptInterface
        public boolean updHasPackage() {
            return updater().hasDownloaded();
        }

        /**
         * 本机主 ABI（"arm64-v8a" / "x86_64" / …），用于挑对更新包（2026-09-23）。
         *
         * 🔴 为什么不等网页自己猜：网页只能从 UA 或 screen 猜，都不可靠。
         *    `Build.SUPPORTED_ABIS[0]` 是系统按优先级排好的**权威**答案 ——
         *    拿它才能保证 arm64 真机不会下到 x86_64 的包（装错要么装不上、要么崩）。
         * ⚠️ 32 位老机器上第 0 项可能是 "armeabi-v7a"，那也该拿 arm64 包吗？
         *    不该 —— 但我们只发 arm64/x86_64 两个包，所以网页侧按
         *    「非 x86 一律 arm64」兜底即可（见 app.js 的 pickAsset）。
         */
        @android.webkit.JavascriptInterface
        public String deviceAbi() {
            try {
                String[] abis = Build.SUPPORTED_ABIS;
                return (abis != null && abis.length > 0 && abis[0] != null) ? abis[0] : "";
            } catch (Throwable t) {
                return "";
            }
        }

        /**
         * 导出 strm 备份到手机「下载」目录（设置页第 4 步「导出备份」按钮调的）。
         *
         * 🔴 为什么必须由**原生**来写文件：WebView 里的网页没有往「下载」目录写的权限，
         *    `<a download>` 在 WebView 里默认连下载都不触发。原生走 MediaStore 一步到位，
         *    而且 **API 29+ 完全免存储权限**（不用碰「所有文件访问」那种特殊权限）。
         * ⚠️ 打包 5000+ 个小文件要几秒 → 放工作线程，结果回主线程再交给页面。
         * ⚠️ 成功失败都回一次（见 reportStrmExport）—— 不然页面那个「正在打包…」永不落地。
         */
        @android.webkit.JavascriptInterface
        public void exportStrm() {
            exportStrmBackup();
        }

        /**
         * strm 本地保存的存储权限引导。
         * API 30+ 跳「所有文件访问」系统设置页（MANAGE_EXTERNAL_STORAGE 是特殊权限，
         * requestPermissions 弹不出来，只能去设置里开）；API 28/29 用标准运行时权限弹窗。
         * 用户授权回来不用刷新 —— 状态行每次轮询都会现查 permOk，自然翻绿。
         */
        @android.webkit.JavascriptInterface
        public void requestStrmStorage() {
            ui.post(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= 30) {
                        try {
                            Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                            i.setData(Uri.parse("package:" + getPackageName()));
                            startActivity(i);
                        } catch (Throwable notFound) {
                            // 个别 ROM 不认带包名的 action → 退到不带参数的全局「所有文件访问」页
                            startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                        }
                    } else {
                        requestPermissions(new String[]{"android.permission.WRITE_EXTERNAL_STORAGE"}, 9099);
                    }
                } catch (Throwable t) {
                    Log.e(TAG, "发起存储权限请求失败", t);
                    Toast.makeText(MainActivity.this, "打不开权限页，请在系统设置里手动授予「所有文件访问」", Toast.LENGTH_LONG).show();
                }
            });
        }

        /**
         * 内置 CloudDrive2 的状态 —— 设置页「内置引擎」那块直接显示用。
         * 返回 JSON 字符串，前端不用再发一次请求就能分辨「正在启动 / 已就绪 / 起不来」。
         */
        @android.webkit.JavascriptInterface
        public String cd2Status() {
            JSONObject o = new JSONObject();
            try {
                boolean running = cd2Alive();
                /* 🔴 进程死了就把「已就绪」一起清掉 —— 否则前端仍以为能用，
                   点「配置网盘」进去又是一片黑屏。
                   顺便按节流把它自动拉起来：用户不该知道它中途挂过。
                   ⚠️ 节流是必须的：这个方法被前端每 1.5 秒轮询一次，
                      它要是反复崩溃，不节流就会变成「每 1.5 秒重启一次」。 */
                if (!running) {
                    cd2Ready = false;
                    long now = System.currentTimeMillis();
                    if (now - cd2LastStartMs > 10000) startCloudDrive2();
                }
                o.put("port", CD2_PORT);
                o.put("used", true);   // CloudDrive2 就是唯一的内置数据源，永远在用
                o.put("ready", cd2Ready);
                o.put("running", running);
                o.put("url", "http://127.0.0.1:" + CD2_PORT + "/dav");
                o.put("adminUrl", "http://127.0.0.1:" + CD2_PORT + "/");
                o.put("error", cd2BootError == null ? "" : cd2BootError);
            } catch (Throwable t) {
                Log.w(TAG, "拼 cd2Status 出错", t);
            }
            return o.toString();
        }

        /**
         * 打开 CloudDrive2 的管理页（登录 CD2 账号、挂载 115 / 夸克 / 阿里云盘…用）。
         * ⚠️ 用 App 自己的 Activity，别甩给系统浏览器：配置过程要登录、提交表单、
         *    可能还要过滑块，跳出去再回来很容易被系统回收，体验也割裂。
         */
        @android.webkit.JavascriptInterface
        public void cd2Admin() {
            ui.post(() -> {
                try {
                    startActivity(new Intent(MainActivity.this, Cd2Activity.class));
                } catch (Throwable t) {
                    Log.e(TAG, "打开 CloudDrive2 管理页失败", t);
                }
            });
        }
    }

    // ================================================================ 内置 CloudDrive2
    //
    // 手机本地跑一个 CloudDrive2 引擎（Rust 写的网盘聚合服务，支持 115/115open、
    // 阿里云盘、迅雷、123、百度、GoogleDrive、OneDrive…），
    // App → 127.0.0.1:19798/dav → 网盘。内置 Alist（OpenList）已整体移除 ——
    // Alist 走 115 的老接口风控太频繁，CD2 引擎模拟官方客户端协议，风控最少。
    //
    // 🔴 二进制为什么必须叫 libclouddrive.so、放在 lib/<abi>/：
    //    Android 10 起应用私有目录是 W^X（可写就不可执行），
    //    **只有 nativeLibraryDir 允许 execve**。所以「首次运行时下载二进制再跑」这条路是死的，
    //    必须由 APK 携带（build.js 的 collectJniLibs 以 STORED 打进 lib/<abi>/），
    //    并且 AndroidManifest 里 extractNativeLibs="true"，安装时才会真的落地成可执行文件。
    //    （CD2 官方 APK 把引擎放在 assets/bin/<arch>/clouddrive，它自己的壳另有 root 方案；
    //     我们没有 root，所以必须走 lib/<abi>/ 这条正路。二进制从 CD2 官方 APK 提取。）
    //
    // 启动协议（2026-09-19 在模拟器上实测 CD2 v1.0.5 官方引擎得出）：
    //   · 环境变量 CLOUDDRIVE_HOME 指向**可写目录**，数据库/日志/配置全落在那里；
    //     不设的话它会去写死路径 /Waytech/CloudDrive2/log，直接崩（Read-only file system）。
    //   · 引擎首次启动会在 CLOUDDRIVE_HOME 里生成 config.toml（默认 http_port 恰好也是
    //     19798、webdav_root="/"）+ 各 sqlite 库；我们启动前预写一份 config.toml 把端口钉死。
    //   · WebDAV 在 http://127.0.0.1:19798/dav，Basic 认证用 CD2 账号
    //     （实测 webdav_enable_guest 写进 config.toml 不生效——引擎启动时会重写它）。
    //     所以用户要先在管理页登录 CD2 账号并挂载 115，再把同一组账号密码
    //     填进「数据源设置」的 WebDAV 表单。

    private File cd2DataDir() {
        File d = new File(getFilesDir(), "cd2");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /**
     * 预写 config.toml —— **只在它不存在时写**。
     *
     * ⚠️ 已存在的配置**不动**：引擎启动时会自己补全/重写它（实测生成的默认值
     *    http_port 就是 19798），硬管反而会和引擎的写入打架。
     */
    private void ensureCd2Config() {
        File cfg = new File(cd2DataDir(), "config.toml");
        if (cfg.exists()) return;
        try (FileOutputStream fo = new FileOutputStream(cfg)) {
            fo.write(("[webconfig]\n"
                + "www_root = \"./wwwroot\"\n"
                + "http_port = " + CD2_PORT + "\n"
                + "https_port = " + (CD2_PORT + 1) + "\n"
                + "enable_https = false\n"
                + "webdav_root = \"/\"\n"
                + "webdav_readonly = false\n"
                + "webdav_enable_guest = false\n").getBytes("UTF-8"));
        } catch (Throwable t) {
            Log.w(TAG, "写 CloudDrive2 配置失败（不致命，引擎会用默认值）", t);
        }
    }

    /**
     * 解压管理页静态文件 —— **只在它不存在时做**。
     *
     * 🔴 没有它，管理页就是一片黑屏：CD2 引擎的 web 管理界面不在二进制里，
     *    官方 App 是把 assets/wwwroot.zip 解到数据目录（config.toml 的
     *    www_root="./wwwroot" 是相对 CLOUDDRIVE_HOME 的）。我们启动前不补上，
     *    `http://127.0.0.1:19798/` 就回 404 空响应 —— WebDAV（/dav）明明活着，
     *    管理页却 404 黑屏，属于最难查的「半死」状态（2026-09-19 用户截图报的就是它）。
     *
     * zip 顶层就是 wwwroot/，直接解进 CLOUDDRIVE_HOME（files/cd2）正好落位。
     */
    private void ensureCd2Wwwroot() {
        File marker = new File(cd2DataDir(), "wwwroot/index.html");
        if (marker.exists()) return;
        try (java.io.InputStream in = getAssets().open("cd2wwwroot.zip");
             java.util.zip.ZipInputStream zin = new java.util.zip.ZipInputStream(in)) {
            byte[] buf = new byte[8192];
            File base = cd2DataDir().getCanonicalFile();
            java.util.zip.ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                File out = new File(base, e.getName());
                // 防 zip-slip：解出来的路径必须还在数据目录里
                if (!out.getCanonicalPath().startsWith(base.getCanonicalPath() + File.separator)) continue;
                if (e.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                out.getParentFile().mkdirs();
                try (FileOutputStream fo = new FileOutputStream(out)) {
                    int n;
                    while ((n = zin.read(buf)) != -1) fo.write(buf, 0, n);
                }
            }
            Log.i(TAG, "已解压 CloudDrive2 管理页静态文件（wwwroot）");
        } catch (Throwable t) {
            Log.w(TAG, "解压 wwwroot 失败（管理页会 404，但不影响 WebDAV）", t);
        }
    }

    /** 启动内置 CloudDrive2 —— 幂等，已经在跑就复用（重启 App 时别起第二个实例） */
    private void startCloudDrive2() {
        synchronized (cd2Lock) {
            cd2LastStartMs = System.currentTimeMillis();   // 自愈节流用（见 cd2Status）
            if (cd2Proc != null && cd2Proc.isAlive()) return;
            /* 端口上已经有人在听？那多半是上一次没退干净的实例（比如系统杀的、
               destroy() 还没来得及生效的）。**复用它** —— 硬起第二个只会 bind 失败
               然后静默退出，表现就是「内置网盘永远连不上」这种最难查的半死状态。 */
            if (portOpen(CD2_PORT)) {
                cd2Ready = true;
                cd2BootError = null;
                Log.i(TAG, ":" + CD2_PORT + " 已有实例在跑，直接复用");
                return;
            }
            File data = cd2DataDir();
            ensureCd2Config();
            ensureCd2Wwwroot();
            File exe = new File(getApplicationInfo().nativeLibraryDir, "libclouddrive.so");
            if (!exe.exists()) {
                cd2BootError = "这个 APK 没带内置 CloudDrive2 引擎（缺 libclouddrive.so）";
                Log.e(TAG, cd2BootError + "：" + exe);
                return;
            }
            try {
                ProcessBuilder pb = new ProcessBuilder(exe.getAbsolutePath());
                // 🔴 CLOUDDRIVE_HOME 必须指向可写目录，否则引擎会去写死路径
                //    /Waytech/CloudDrive2/log 直接崩（实测：Read-only file system）。
                pb.environment().put("CLOUDDRIVE_HOME", data.getAbsolutePath());
                pb.directory(data);
                pb.redirectErrorStream(true);
                pb.redirectOutput(new File(data, "stdout.log"));
                cd2Proc = pb.start();
                cd2BootError = null;
                Log.i(TAG, "内置 CloudDrive2 已拉起：" + exe.getAbsolutePath());
            } catch (Throwable t) {
                cd2BootError = "启动内置 CloudDrive2 失败：" + t.getMessage();
                Log.e(TAG, cd2BootError, t);
                return;
            }
        }
        // 就绪探测丢后台：首次要建库，别卡住主线程（WebView 还得加载）
        new Thread(this::waitCd2Ready, "cd2-boot").start();
    }

    private boolean cd2Alive() {
        synchronized (cd2Lock) { return cd2Proc != null && cd2Proc.isAlive(); }
    }

    /** 127.0.0.1:port 上有没有人在监听（用来判断内置服务起没起来 / 是否已有实例） */
    private static boolean portOpen(int port) {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress("127.0.0.1", port), 300);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 轮询端口，直到它开始监听（或超时 / 进程死掉） */
    private void waitCd2Ready() {
        final long deadline = System.currentTimeMillis() + CD2_BOOT_MS;
        while (System.currentTimeMillis() < deadline) {
            if (!cd2Alive()) {
                cd2BootError = "内置 CloudDrive2 进程已退出（日志：cd2/stdout.log）";
                Log.w(TAG, cd2BootError);
                return;
            }
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress("127.0.0.1", CD2_PORT), 400);
                cd2Ready = true;
                Log.i(TAG, "内置 CloudDrive2 已就绪，监听 :" + CD2_PORT);
                return;
            } catch (Throwable ignored) {
                // 还没起来，接着等
            }
            try { Thread.sleep(400); } catch (InterruptedException e) { return; }
        }
        cd2BootError = "内置 CloudDrive2 启动超时";
        Log.w(TAG, cd2BootError);
    }

    private void stopCloudDrive2() {
        synchronized (cd2Lock) {
            cd2Ready = false;
            if (cd2Proc == null) return;
            try { cd2Proc.destroy(); } catch (Throwable ignored) { /* 已经退了 */ }
            cd2Proc = null;
            Log.i(TAG, "内置 CloudDrive2 已停止");
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        /* 换头像的文件选择器回来了 —— 无论选没选都必须回一次 callback，
           不然网页那边 onShowFileChooser 的 Promise 永远不落地。 */
        if (req == REQ_FILE) {
            if (fileCallback == null) return;
            Uri[] out = null;
            if (res == RESULT_OK && data != null && data.getData() != null) {
                out = new Uri[]{ data.getData() };
            }
            fileCallback.onReceiveValue(out);
            fileCallback = null;
            return;
        }
        if (req != REQ_PLAYER || data == null) return;
        String path = data.getStringExtra(PlayerActivity.EX_PATH);
        int pos = data.getIntExtra(PlayerActivity.EX_POS, 0);
        if (path == null || path.isEmpty()) return;
        String q = JSONObject.quote(path);
        if (res == PlayerActivity.RESULT_FALLBACK) {
            // 原生也播不动 —— 通知网页自己接管
            web.evaluateJavascript("window.__nasFallback&&window.__nasFallback(" + q + ")", null);
        } else {
            web.evaluateJavascript("window.__nasPos&&window.__nasPos(" + q + "," + pos + ")", null);
        }
    }

    /* ------------------------------------------------------------ strm 备份导出 */

    /**
     * 打包 strm 备份并写进「下载」目录，结果通过 `window.__strmExportDone(json)` 回给页面。
     * ⚠️ 磁盘 I/O + zip 压缩 → 必须工作线程；⚠️ 失败也要回一次，否则页面等的回调不来。
     */
    private void exportStrmBackup() {
        final NasServer srv = nas;
        if (srv == null) { reportStrmExport(false, 0, null, "本地服务还没起来"); return; }
        new Thread(() -> {
            try {
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream(1 << 20);
                int n = srv.strmBackupWrite(bos);
                byte[] zip = bos.toByteArray();
                String name = "nas-strm-backup-"
                        + new java.text.SimpleDateFormat("yyyyMMdd-HHmm", java.util.Locale.US)
                        .format(new java.util.Date()) + ".zip";
                String where = writeZipToDownloads(zip, name);
                Log.i(TAG, "strm 备份已导出：" + where + "（" + n + " 个文件 / " + zip.length + " 字节）");
                reportStrmExport(true, n, where, null);
            } catch (Throwable t) {
                Log.e(TAG, "导出 strm 备份失败", t);
                reportStrmExport(false, 0, null, String.valueOf(t.getMessage()));
            }
        }, "strm-export").start();
    }

    /**
     * 把 zip 写到用户**找得到**的地方，优先「下载」目录，逐级降级：
     *   ① API 29+：MediaStore（免权限；重名由系统自动加 `(1)`）
     *   ② ≤28 或 MediaStore 失败：公共 Downloads 目录（这一路要 WRITE_EXTERNAL_STORAGE）
     *   ③ 都不行：应用自己的外部目录（免权限，但要在文件管理器里翻 Android/data）
     * 返回**给人看的位置说明**（如 `下载/nas-strm-backup-20260920-1730.zip`），页面直接展示。
     */
    private String writeZipToDownloads(byte[] zip, String name) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                android.content.ContentValues cv = new android.content.ContentValues();
                cv.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name);
                cv.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "application/zip");
                cv.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH,
                        android.os.Environment.DIRECTORY_DOWNLOADS);
                Uri uri = getContentResolver().insert(
                        android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri != null) {
                    java.io.OutputStream os = getContentResolver().openOutputStream(uri);
                    if (os != null) {
                        try {
                            os.write(zip);
                        } catch (Throwable t) {
                            try { os.close(); } catch (Throwable ignore) {}
                            throw t;
                        }
                        os.close();
                        return "下载/" + name;
                    }
                }
            } catch (Throwable t) {
                Log.w(TAG, "MediaStore 写入失败，退公共下载目录：" + t.getMessage());
            }
        }
        try {
            File dir = android.os.Environment.getExternalStoragePublicDirectory(
                    android.os.Environment.DIRECTORY_DOWNLOADS);
            if (dir != null && (dir.isDirectory() || dir.mkdirs())) {
                File f = new File(dir, name);
                FileOutputStream os = new FileOutputStream(f);
                try { os.write(zip); } finally { os.close(); }
                return f.getAbsolutePath();
            }
        } catch (Throwable t) {
            Log.w(TAG, "公共下载目录写入失败，退应用目录：" + t.getMessage());
        }
        File base = getExternalFilesDir(null);
        if (base == null) base = getFilesDir();
        File fb = new File(base, "export");
        if (!fb.isDirectory() && !fb.mkdirs()) throw new Exception("手机上没有可写的目录");
        File f = new File(fb, name);
        FileOutputStream os = new FileOutputStream(f);
        try { os.write(zip); } finally { os.close(); }
        return f.getAbsolutePath();
    }

    /** 把导出结果回给页面（成功/失败都回，否则页面那句「正在打包…」永远不消失） */
    private void reportStrmExport(boolean ok, int files, String where, String err) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", ok);
            o.put("files", files);
            o.put("where", where == null ? "" : where);
            o.put("err", err == null ? "" : err);
        } catch (Throwable ignore) {}
        final String js = "window.__strmExportDone&&window.__strmExportDone(" + o.toString() + ")";
        final String e2 = err;
        ui.post(() -> {
            try { web.evaluateJavascript(js, null); } catch (Throwable ignore) {}
            if (!ok) {
                Toast.makeText(MainActivity.this, "导出失败：" + e2, Toast.LENGTH_LONG).show();
            }
        });
    }

    private class Chrome extends WebChromeClient {
        /* 网页里所有 <input type=file> 都走这里（2026-09-19 加，2026-09-20 扩到备份导入）。
         *   · 换头像：accept="image/*"          → 照片选择器
         *   · 导入备份：accept=".zip,application/zip" → 文件选择器（DocumentsUI）
         * ⚠️ 没有这个回调时 WebView 会**静默忽略**文件选择 —— 用户点了没反应，
         *    还以为功能坏了。结果码用独立的 REQ_FILE，别跟 REQ_PLAYER 混。 */
        @Override
        public boolean onShowFileChooser(WebView v, android.webkit.ValueCallback<Uri[]> cb,
                                         FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);   // 上一次没收尾就作废
            fileCallback = cb;
            try {
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                /* 🔴 意图类型必须**按网页给的 accept 推导**，绝不能写死 image/*。
                 *
                 * 这个回调最早只服务「换头像」，于是 `setType("image/*")` 被写死了 ——
                 * 结果 2026-09-20 加「导入备份」时（`<input accept=".zip,application/zip">`）
                 * 也被丢给图片选择器，而 **Android 13+ 的照片选择器里根本没有 zip**：
                 * 用户点「导入备份」只会看到一个选不了东西的照片列表（模拟器实测确认，
                 * 界面文案是「此应用只能访问您选择的照片」）→ 换机流程直接卡死。
                 *
                 * 规则：
                 *   · 扩展名项（`.zip`）不是 MIME —— Chrome 有时会原样递过来，认得的补成 MIME；
                 *   · 剩下的：唯一 → setType；多个 → setType(第一个) + EXTRA_MIME_TYPES；
                 *   · 纯图片仍走 image/*（照片选择器对头像就是最好的体验，别改坏）；
                 *   · 一个都没解析出来才退到「任意类型」。
                 * ⚠️ 注释里别写星号加斜杠那对字符（哪怕是在引号里当通配符举例）——
                 *    块注释会被它**提前结束**，后面全是语法错误（本次真踩了）。 */
                java.util.List<String> mimes = new java.util.ArrayList<>();
                for (String a : params.getAcceptTypes()) {
                    if (a == null) continue;
                    String s = a.trim().toLowerCase();
                    if (s.isEmpty()) continue;
                    if (s.startsWith(".")) {
                        if (s.equals(".zip")) s = "application/zip";
                        else continue;
                    }
                    if (!mimes.contains(s)) mimes.add(s);
                }
                boolean imageOnly = !mimes.isEmpty();
                for (String m : mimes) if (!m.startsWith("image/")) imageOnly = false;
                if (mimes.isEmpty()) {
                    pick.setType("*/*");
                } else if (imageOnly) {
                    pick.setType("image/*");
                } else {
                    pick.setType(mimes.get(0));
                    if (mimes.size() > 1) {
                        pick.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
                    }
                }
                Log.i(TAG, "文件选择器：accept=" + java.util.Arrays.toString(params.getAcceptTypes())
                        + " → type=" + pick.getType() + " imageOnly=" + imageOnly);
                startActivityForResult(
                        Intent.createChooser(pick, imageOnly ? "选择头像图片" : "选择文件"), REQ_FILE);
            } catch (Throwable t) {
                Log.w(TAG, "起文件选择器失败", t);
                fileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback cb) {
            if (customView != null) {         // 已经在全屏里了，忽略重复请求
                cb.onCustomViewHidden();
                return;
            }
            customView = view;
            webHolder.setVisibility(View.GONE);          // 连 WebView 一起摘掉，省一层合成
            root.addView(view, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT));
            applyImmersive(true);
            Log.i(TAG, "enter fullscreen");        }

        @Override
        public void onHideCustomView() {
            if (customView == null) return;
            root.removeView(customView);
            customView = null;
            webHolder.setVisibility(View.VISIBLE);
            applyImmersive(false);
            Log.i(TAG, "exit fullscreen");
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                Log.e(TAG, "js: " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
            }
            return true;
        }
    }

    /**
     * 系统是不是深色。读的是 **系统的 uiMode**（`cmd uimode night yes/no` 改的就是它），
     * 不是 App 主题 —— 见 NasBridge.systemTheme 的注释，这两件事在 WebView 里是分开的。
     */
    private boolean isSystemDark() {
        try {
            int mode = getResources().getConfiguration().uiMode
                    & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
            return mode == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        } catch (Throwable t) {
            return true;   // 读不到就按深色（和缺省主题一致）
        }
    }

    /** 系统深浅色变了 → 叫网页重算一遍（只有「跟随系统」档会真的跟着动） */
    private void pushSystemTheme() {
        try {
            web.evaluateJavascript(
                    "(function(){try{if(window.__onSystemTheme)window.__onSystemTheme();}catch(e){}})()",
                    null);
        } catch (Throwable t) {
            Log.w(TAG, "推送系统主题失败", t);
        }
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration cfg) {
        super.onConfigurationChanged(cfg);
        /* 🔴 manifest 里 MainActivity 声明了 uiMode（见 AndroidManifest.xml 的注释：
           不声明的话转屏/弹键盘都会重建 Activity，全屏播放会「从头加载」）。
           代价是**系统切换深浅色时 Activity 不会重建** —— 所以这里必须主动通知网页，
           否则「跟随系统」档要等下次冷启动才生效。 */
        Log.i(TAG, "配置变更：系统主题 = " + (isSystemDark() ? "深色" : "浅色"));
        pushSystemTheme();
    }

    /** 全屏播放时把状态栏、导航栏一起收掉（名字不能叫 setImmersive，Activity 自己有一个） */
    private void applyImmersive(boolean on) {
        View d = getWindow().getDecorView();
        if (on) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
            /* ⚠️ 上面这行会把 LIGHT_STATUS_BAR 一起清掉（它是整体赋值，不是按位或），
               所以退出全屏后必须把主题的图标配色补回来 —— 漏了的话「看完全屏回来，
               浅色界面顶上状态栏图标又变白了」。 */
            applySystemBarTheme(lightTheme);
        }
    }

    /**
     * 系统栏（状态栏 + 导航栏）配色：浅色主题用浅底 + 深图标，深色主题反过来。
     *
     * 🔴 为什么必须由原生做：网页里的 {@code <meta name="theme-color">} 对 **WebView 无效**
     *    （那是给浏览器地址栏 / PWA 标题栏用的），状态栏颜色只能走 Window API。
     *    不做的话浅色界面顶上会永远留一条黑边，看着像没换干净。
     *
     * ⚠️ 用到的三个 API 最低版本（statusBarColor 21 / LIGHT_STATUS_BAR 23 /
     *    LIGHT_NAVIGATION_BAR 26）都低于本项目 minSdk 28，所以不用做版本判断。
     */
    private void applySystemBarTheme(boolean light) {
        try {
            int color = light ? 0xFFF4F5F7 : 0xFF000000;   // 与 style.css 的 --page-bg 对齐
            getWindow().setStatusBarColor(color);
            getWindow().setNavigationBarColor(color);
            View d = getWindow().getDecorView();
            int f = d.getSystemUiVisibility();
            if (light) {
                f |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            } else {
                f &= ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
            }
            d.setSystemUiVisibility(f);
            Log.i(TAG, "系统栏配色：" + (light ? "浅色" : "深色"));
        } catch (Throwable t) {
            Log.w(TAG, "改系统栏配色失败（不影响换主题本身）", t);
        }
    }

    // ---------------------------------------------------------------- 生命周期

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();          // 切到后台别继续解码
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        cancelTimeout();
        if (customView != null) chrome.onHideCustomView();
        if (nas != null) nas.stop();
        /* 内置 CloudDrive2 跟着 Activity 生命周期走：退到后台不管它（看片时 App 一定在前台），
           真正销毁时才杀。⚠️ 「重启应用」走的是 recreate()，也会经过这里 ——
           所以它被杀掉后会被 onCreate 重新拉起（端口有几百毫秒空档，前端已就绪探测兜着）。 */
        stopCloudDrive2();
        if (web != null) {
            web.setWebChromeClient(null);
            web.destroy();
        }
        super.onDestroy();
    }
}
