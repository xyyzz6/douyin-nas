package com.nas.douyin;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.net.InetSocketAddress;
import java.net.Socket;

/**
 * 内置 CloudDrive2 引擎的管理页（WebView 套壳）。
 *
 * 用户在这里：登录 CD2 账号 → 挂载 115 / 夸克 / 阿里云盘…等网盘
 * → 之后「数据源设置」里用同一组 CD2 账号密码连 127.0.0.1:19798/dav 就能扫到片子。
 *
 * ⚠️ **不能一进来就 loadUrl** —— 内置引擎是 App 启动时异步拉起的，首次还要建库（几秒）；
 *    这时候 load 一个连不上的地址，WebView 只会给一片**黑屏 + 一个破图标**。
 *    现在的做法：**先探端口、等它就绪，再加载**；等不到就显示**能看懂的原因 + 重试按钮**。
 *
 * ⚠️ 不写 XML 布局，纯代码搭 —— 这个页面只有「一个铺满的 WebView + 一块提示」。
 *
 * 🔴 **必须有 WebChromeClient 实现 onJsAlert/onJsConfirm/onJsPrompt**（2026-09-20 加）。
 *    管理页的破坏性操作（移除云存储/挂载点/备份、清缓存、重启服务）全走原生
 *    `confirm()`；WebView 默认不实现这个回调 = 默认当「取消」→ 点了什么都不发生，
 *    且无异常无请求，极难查。改这个文件时别把 WebChromeClient 删了。
 */
public class Cd2Activity extends Activity {

    private static final String TAG = "NasDouyin";
    private static final String HOME = "http://127.0.0.1:" + MainActivity.CD2_PORT + "/";
    /** 等内置引擎就绪的上限（和 MainActivity 的 CD2_BOOT_MS 同量级） */
    private static final int WAIT_MS = 30000;

    private WebView web;
    private LinearLayout hintBox;
    private TextView hintText;
    private Button retryBtn;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        // ---- WebView（先不显示，等就绪才加载） ----
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);            // CD2 管理页要存登录态
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);                  // 管理页是给桌面浏览器设计的，手机上得能缩放
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.setBackgroundColor(Color.BLACK);
        web.setVisibility(View.GONE);
        web.setWebViewClient(new WebViewClient() {
            /** 主文档加载失败（比如引擎中途挂了）→ 不要停在黑屏，给提示和重试 */
            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req == null || !req.isForMainFrame()) return;   // 子资源失败不打扰用户
                CharSequence d = err == null ? "" : err.getDescription();
                Log.w(TAG, "CD2 管理页加载失败：" + d);
                showHint("管理页打不开：" + d + "\n\n内置引擎可能没在跑。", true);
            }

            /** 🔴 主文档回 4xx/5xx（比如 wwwroot 没解出来时的 404 空响应）也是黑屏，同样要兜住 */
            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest req, WebResourceResponse resp) {
                if (req == null || !req.isForMainFrame()) return;
                int code = resp == null ? 0 : resp.getStatusCode();
                if (code >= 400) {
                    Log.w(TAG, "CD2 管理页返回 HTTP " + code);
                    showHint("管理页打不开（HTTP " + code + "）。\n\n"
                        + "内置引擎在跑，但它的管理页文件可能没就位 —— 回到 App 重启一次再试。", true);
                }
            }
        });

        /* ================================================================
         * 🔴 JS 原生弹窗（2026-09-20 修「云存储移除不了」）
         * ----------------------------------------------------------------
         * 症状：管理页「云存储」里的「移除」点了毫无反应 —— 不弹框、不报错、
         *      也没有任何网络请求，网盘就一直挂在那儿删不掉。
         *
         * 根因：CD2 管理页所有**破坏性操作**都用浏览器原生 `confirm()` 做二次确认
         *      （移除云存储 / 移除挂载点 / 移除备份 / 清空缓存 / 重启服务…）。
         *      而 WebView **默认不实现 onJsConfirm** —— 它的默认行为是当用户点了
         *      「取消」，直接 `confirm() == false`，于是页面**静默放弃**这次删除。
         *      整个过程没有任何异常可捕获，所以控制台干干净净，最难查。
         *      （实测：拦一层 window.confirm 就能拿到「您确定要删除 342399294
         *        （115open）的云存储连接吗？此操作无法撤消。」——说明点击本身是好的，
         *        卡在弹窗没渲染出来。）
         *
         * 修法：补上 WebChromeClient 的三个回调，用系统 AlertDialog 把原生弹窗
         *      画出来。**这不是「加分项」，是管理页能用的前提。**
         *
         * ⚠️ 三个回调都必须真正「收尾」：
         *    · onJsConfirm → 确定 `confirm(true)` / 取消 `confirm(false)`
         *    · onJsAlert  → `confirm()`（无返回值，但必须调，否则页面回调链断掉）
         *    · onJsPrompt → `promptResult.confirm(文本)` 或 `promptResult.cancel()`
         *    漏掉收尾会让页面的 await 永远挂着，表现为「点了没反应」的同类症状。
         *
         * ⚠️ 不能用 `setWebChromeClient(null)` 收尾（见下面 onDestroy）—— 那是
         *    拆引用防泄漏，别误删；但也不能在别处把它清掉，清了弹窗就又没了。
         * ================================================================ */
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView v, String url, String message, final JsResult result) {
                new AlertDialog.Builder(Cd2Activity.this)
                    .setMessage(message)
                    .setPositiveButton("确定", (d, w) -> result.confirm())
                    // 返回键 / 点外部关掉也要收尾，否则 JS 侧回调永远不返回
                    .setOnCancelListener(d -> result.confirm())
                    .setCancelable(true)
                    .show();
                return true;                     // true = 我们自己处理了
            }

            @Override
            public boolean onJsConfirm(WebView v, String url, String message, final JsResult result) {
                new AlertDialog.Builder(Cd2Activity.this)
                    .setMessage(message)
                    .setPositiveButton("确定", (d, w) -> result.confirm())
                    .setNegativeButton("取消", (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .setCancelable(true)
                    .show();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView v, String url, String message, String defaultValue,
                                      final JsPromptResult result) {
                final EditText input = new EditText(Cd2Activity.this);
                input.setInputType(InputType.TYPE_CLASS_TEXT);
                if (defaultValue != null) input.setText(defaultValue);
                new AlertDialog.Builder(Cd2Activity.this)
                    .setMessage(message)
                    .setView(input)
                    .setPositiveButton("确定", (d, w) -> result.confirm(input.getText().toString()))
                    .setNegativeButton("取消", (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .setCancelable(true)
                    .show();
                return true;
            }
        });

        // ---- 提示区（居中的一段字 + 重试按钮） ----
        hintBox = new LinearLayout(this);
        hintBox.setOrientation(LinearLayout.VERTICAL);
        hintBox.setGravity(Gravity.CENTER);
        hintBox.setPadding(dp(28), dp(28), dp(28), dp(28));

        hintText = new TextView(this);
        hintText.setTextColor(Color.parseColor("#DDDDDD"));
        hintText.setTextSize(14f);
        hintText.setLineSpacing(dp(4), 1f);
        hintText.setGravity(Gravity.CENTER);
        hintBox.addView(hintText);

        retryBtn = new Button(this);
        retryBtn.setText("重试");
        retryBtn.setVisibility(View.GONE);
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        blp.topMargin = dp(18);
        retryBtn.setLayoutParams(blp);
        retryBtn.setOnClickListener(v -> waitThenLoad());
        hintBox.addView(retryBtn);

        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(hintBox, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        waitThenLoad();
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    /** 先等内置引擎就绪，再加载管理页；等不到就如实说清楚 */
    private void waitThenLoad() {
        showHint("正在启动内置 CloudDrive2 引擎…\n首次启动要建库，通常几秒。", false);
        new Thread(() -> {
            long deadline = System.currentTimeMillis() + WAIT_MS;
            while (System.currentTimeMillis() < deadline) {
                if (portOpen()) {
                    ui.post(this::loadHome);
                    return;
                }
                try {
                    Thread.sleep(400);
                } catch (InterruptedException e) {
                    return;                      // Activity 没了
                }
            }
            ui.post(() -> showHint("内置引擎一直没起来（等了 " + (WAIT_MS / 1000) + " 秒）。\n\n"
                + "先去「我的 → 数据源设置」，最上面那行会写它为什么起不来；\n"
                + "修好之后回到这里点「重试」。", true));
        }, "cd2-wait").start();
    }

    private void loadHome() {
        if (web == null) return;                 // 已经退出了
        hintBox.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(HOME);
        Log.i(TAG, "打开 CloudDrive2 管理页：" + HOME);
    }

    private void showHint(String text, boolean retry) {
        if (hintBox == null) return;
        hintText.setText(text);
        retryBtn.setVisibility(retry ? View.VISIBLE : View.GONE);
        hintBox.setVisibility(View.VISIBLE);
        if (web != null) web.setVisibility(View.GONE);
    }

    /** 127.0.0.1:19798 有没有人在听 */
    private static boolean portOpen() {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress("127.0.0.1", MainActivity.CD2_PORT), 400);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 返回键先在网页里回退 —— 配网盘要翻好几层，一按就退出会让人崩溃 */
    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK && web != null
                && web.getVisibility() == View.VISIBLE && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(code, e);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.setWebChromeClient(null);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
