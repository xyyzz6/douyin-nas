package com.nas.douyin;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.RenderersFactory;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.ui.AspectRatioFrameLayout;

import java.util.ArrayList;
import java.util.List;

/**
 * 原生全屏播放器。
 *
 * =====================================================================================
 *  为什么换成 ExoPlayer（2026-09-17）
 * =====================================================================================
 * 以前这里用 android.media.MediaPlayer，它的容器解析是系统写死的、只认 MP4/3GP 那一套。
 * 用户丢进来一个 .avi，MediaPlayer 直接 onError —— 网页那边的 <video> 同样放不了，
 * 于是整条链路对 AVI/MKV/FLV 这些封装是**死**的（错误提示只能说「浏览器放不了这种封装」）。
 *
 * ExoPlayer 自带一整套 Extractor（AVI / MKV / FLV / TS / MP4 / OGG / FLAC / MP3 / WAV / AMR …），
 * 封装解析不再依赖系统。实测 extractor 里就有 AviExtractor，所以 .avi 能进得去。
 *
 * ⚠️ 但要说清楚**边界**：ExoPlayer 只负责「解封装」，音视频轨最终仍然交给系统 MediaCodec 解码。
 *    这一版**没有**引入 FFmpeg 软解（那得搬一坨 .so 进来，包会大几十 MB）。
 *    所以：
 *      · AVI 里装 H.264 / MPEG-4 / MP3 / AAC  → 能播（芯片支持）
 *      · AVI 里装老解码器（如某些 DivX 变种）→ 仍然播不了，这时才回退给网页
 *    这个限制是真的，别在 UI 里假装它不存在（见 showError 里的文案）。
 *
 * =====================================================================================
 *  为什么是 Media3 而不是 com.google.android.exoplayer2（2026-09-17 半夜补记）
 * =====================================================================================
 * Xplayer 自己用的是 ExoPlayer 2.19.1。我照做拉了那套 aar，结果**那套包是坏的**：
 * NalUnitUtil 被 Mp4Extractor / MatroskaExtractor / FlvExtractor 等一票类引用，
 * 却不存在于 2.19.1 的任何一个模块（extractor / core / common 全查过，2.18.2 也没有）。
 * 更要命的是 DefaultExtractorsFactory 是**按 URL 扩展名分发**的：一个 .avi 会顺手把
 * mp4 系 extractor 也 new 出来，于是真机上一点播放就
 *     NoClassDefFoundError: Failed resolution of: ...exoplayer2.util.NalUnitUtil
 * 崩在 ExoPlayer:Loader:ProgressiveMediaPeriod 线程里。
 * 当时用自写的 NasExtractorsFactory 把它绕开了，代价是 MP4/MKV 一起废掉。
 *
 * 最后改用 **Media3 1.4.1** —— ExoPlayer 的官方后继版本、同一套引擎血统，
 * NalUnitUtil 老老实实待在 media3-container 里，官方 DefaultExtractorsFactory 直接可用。
 * 这是对「用 Xplayer 的内核」这个要求的一处**有意偏离**：引擎血统没变，包名变了。
 */
public class PlayerActivity extends Activity implements Player.Listener {

    private static final String TAG = "NasPlayer";

    static final String EX_URL = "url";       // 直连流地址（完整 http://）
    static final String EX_ENC = "enc";       // 重编码流地址（直连播不动时兜底）
    static final String EX_TITLE = "title";
    static final String EX_POS = "pos";       // 起始位置（秒）
    static final String EX_PATH = "path";     // 视频在片库里的路径，回传位置用
    static final int RESULT_FALLBACK = 42;    // 原生也播不动，让网页自己来

    // ---------------- Xplayer 设计 token（改观感只改这里） ----------------
    private static final int C_STYLE = 0xFF1DBA5B;        // player_style
    private static final int C_GRAD_START = 0xFF37CAF9;   // player_progress_start
    private static final int C_GRAD_END = 0xFF1DBA5B;     // player_progress_end
    private static final int C_TRACK = 0x33FFFFFF;        // player_seek_progress background
    private static final int C_BUFFERED = 0x66FFFFFF;     // secondaryProgress
    private static final int C_GESTURE_BG = 0xB3000000;   // player_gesture_content_bg
    private static final int C_GESTURE_TRACK = 0x33FFFFFF;// player_gesture_background
    private static final int BAR_H = 48;                  // player_bar_height
    private static final int SHADOW_H = 72;               // player_bar_shadow_height
    private static final int BTN = 36;                    // player_btn_width

    /** 横滑一整屏 = 快进/快退这么多毫秒。Xplayer 里是写死的 120000 */
    private static final long SEEK_FULL_MS = 120000L;
    private static final int HIDE_DELAY = 4000;

    private final Handler ui = new Handler(Looper.getMainLooper());

    // 视图
    private FrameLayout root;
    private AspectRatioFrameLayout aspectBox;
    private View surfaceView;         // SurfaceView 或 TextureView
    private View touchLayer;
    private View bottomBar;
    private View topBar;
    private View gesturePanel;
    private android.widget.ImageView gestureIcon;
    private TextView gestureText;
    private ProgressBar gestureProgress;
    private View centerPlay;
    private View completionView;

    private SeekBar bar;
    private GradientProgressDrawable barDraw;
    private TextView tvNow, tvAll, tvTitle, tvCenterHint;
    private ProgressBar spin;
    private android.widget.ImageView btnPlay;
    private android.widget.ImageView btnPlayBar;

    private final List<View> chrome = new ArrayList<>();   // 一起显隐的控件

    // 播放器
    private ExoPlayer player;
    private DefaultTrackSelector trackSelector;
    private boolean tryingSoftware = false;
    private boolean triedEncode = false;
    private boolean fallback = false;
    private boolean prepared = false;
    private boolean dragging = false;

    private String url, encUrl, title, path;
    private int startSec = 0;
    private long durationMs = C.TIME_UNSET;
    private int videoW = 0, videoH = 0;
    private int resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT;   // 缩放模式
    /**
     * 当前已经请求过的屏幕方向（`SCREEN_ORIENTATION_*`）。
     *
     * 为什么要记：方向是**跟着画面**定的（见 onVideoSizeChanged），
     * 而那个回调会被反复触发（seek、换流、分辨率切换）。`setRequestedOrientation`
     * 是异步的，反复调会闪一下 —— 只有真的变了才调。
     */
    private int appliedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    /** 上游临时性 IO 错误已经重试了几次（换片时清零，见 onNewIntent） */
    private int ioRetry = 0;

    // 手势
    private long lastTapMs = 0;
    private float downX = 0, downY = 0;
    private int mode = MODE_NONE;      // 本次滑动在调什么
    private int seekBaseMs = 0, seekTargetMs = -1;
    private float baseBrightness = -1f;
    private int baseVolume = 0, maxVolume = 1;
    private AudioManager audio;

    private static final int MODE_NONE = 0, MODE_SEEK = 1, MODE_VOLUME = 2, MODE_BRIGHT = 3;
    private final Runnable singleTap = () -> toggleControls();

    // ------------------------------------------------------------------ 生命周期

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        Intent it = getIntent();
        url = it.getStringExtra(EX_URL);
        encUrl = it.getStringExtra(EX_ENC);
        title = it.getStringExtra(EX_TITLE);
        path = it.getStringExtra(EX_PATH);
        startSec = it.getIntExtra(EX_POS, 0);

        if (url == null || url.isEmpty()) {
            Toast.makeText(this, "没有视频地址", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }

        audio = (AudioManager) getSystemService(AUDIO_SERVICE);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        /* 🔴 这里**故意不锁方向**（2026-09-19 用户反馈：「加载视频为什么老是横屏」）。
         *
         * 原来这行写的是 `SCREEN_ORIENTATION_SENSOR_LANDSCAPE` —— 无条件横屏。
         * 对横屏片没毛病，但这 App 刷的是**竖屏短视频**，竖屏片被塞进横屏里
         * 画面就缩成中间一小条，等于把片子看废了。
         *
         * 现在改成**跟着画面走**：等 onVideoSizeChanged 拿到真实宽高再定方向。
         * 拿到之前不设置 —— Activity 就维持调用方留下的方向，不会先横一下再转回来。
         */
        applyImmersive();

        buildUI();
        buildPlayer();
        startPlayback(false);
        showControls(true);
    }

    /**
     * 🔴 没有这个方法，「播放器开着的时候再点一部片」就是坏的（2026-09-19 实锤）。
     *
     * manifest 里是 `launchMode="singleTask"`：第二次 `openPlayer` **不会**走 onCreate，
     * 只会把已存在的实例提到前台 —— 新视频的地址/标题被整个丢掉，
     * 屏幕上永远挂着**上一个片子**的画面（通常是报错）。
     * 用户看到的就是「随便点哪部都显示『取不到视频流』」，其实是他第一次撞上的那部的残影。
     *
     * 所以必须把新 intent 吃下去：换地址、换标题、重置兜底状态、重新起播。
     */
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        url = intent.getStringExtra(EX_URL);
        encUrl = intent.getStringExtra(EX_ENC);
        title = intent.getStringExtra(EX_TITLE);
        path = intent.getStringExtra(EX_PATH);
        startSec = intent.getIntExtra(EX_POS, 0);
        if (url == null || url.isEmpty() || player == null) return;   // 异常时序交给 onCreate 兜

        Log.i(TAG, "onNewIntent 换片 " + title + " -> " + url);
        tvTitle.setText(title == null ? "" : title);
        /* 换片就是一次全新的尝试：上一部片留下的兜底状态必须清掉，
           否则「上一部是解码失败」会连累这一部直接跳过硬解/直连。 */
        triedEncode = false;
        tryingSoftware = false;
        ioRetry = 0;
        /* 方向也要重新定 —— 新片子的画面比例很可能不一样，
           不清的话 onVideoSizeChanged 会因为「值没变」跳过 setRequestedOrientation。 */
        appliedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        startPlayback(false);
        showControls(true);
    }

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                getResources().getDisplayMetrics());
    }

    // ------------------------------------------------------------------ 界面搭建

    private void buildUI() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 画面：用 AspectRatioFrameLayout 才能做「原始比例 / 拉伸 / 裁剪」三种缩放模式
        aspectBox = new AspectRatioFrameLayout(this);
        aspectBox.setResizeMode(resizeMode);
        surfaceView = createSurface();
        aspectBox.addView(surfaceView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(aspectBox, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT,
                Gravity.CENTER));

        // 手势层：盖在画面上，控件在它上面 → 点按钮不会被手势吃掉
        touchLayer = new View(this);
        touchLayer.setOnTouchListener((v, e) -> onTouch(e));
        root.addView(touchLayer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        buildTopBar();
        buildCenter();
        buildBottomBar();
        buildGesturePanel();
        buildCompletion();

        // 出错提示（默认藏起来）
        tvCenterHint = new TextView(this);
        tvCenterHint.setTextColor(Color.WHITE);
        tvCenterHint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        tvCenterHint.setPadding(dp(18), dp(12), dp(18), dp(12));
        tvCenterHint.setBackground(roundRect(0xCC000000, 8));
        tvCenterHint.setVisibility(View.GONE);
        tvCenterHint.setOnClickListener(v -> fallbackToWeb());
        root.addView(tvCenterHint, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER));
    }

    /** 平台新一点就用 TextureView：ExoPlayer 官方推荐，旋转/动画不掉帧；老设备退回 SurfaceView */
    private View createSurface() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            android.view.TextureView tv = new android.view.TextureView(this);
            return tv;
        }
        return new android.view.SurfaceView(this);
    }

    private void buildTopBar() {
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(12), dp(10), dp(12), dp(10));
        // 渐变阴影：上深下透（Xplayer 的 ic_player_shadow_top 同款观感）
        top.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0xCC000000, 0x00000000}));

        TextView back = new TextView(this);
        back.setText("‹");
        back.setTextColor(Color.WHITE);
        back.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        back.setGravity(Gravity.CENTER);
        back.setPadding(0, 0, 0, dp(4));
        clickable(back, v -> finish());
        top.addView(back, new LinearLayout.LayoutParams(dp(38), dp(38)));

        tvTitle = new TextView(this);
        tvTitle.setText(title == null ? "" : title);
        tvTitle.setTextColor(Color.WHITE);
        tvTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        tvTitle.setSingleLine(true);
        tvTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        tvTitle.setPadding(dp(6), 0, dp(6), 0);
        // 标题自动撑开中间，把右边的按钮顶到最右（Xplayer 的 controller_title 就是这么干的）
        top.addView(tvTitle, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        // 缩放模式：原始 / 铺满 / 裁剪（Xplayer 里是菜单项，这里直接放出来更顺手）
        TextView fit = new TextView(this);
        fit.setText("缩放");
        fit.setTextColor(Color.WHITE);
        fit.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        fit.setGravity(Gravity.CENTER);
        fit.setPadding(dp(10), dp(6), dp(10), dp(6));
        fit.setBackground(roundRect(0x33FFFFFF, 20));
        fit.setOnClickListener(v -> cycleResize(fit));
        top.addView(fit, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        topBar = top;
        root.addView(top, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP));
        chrome.add(top);
    }

    private void buildCenter() {
        spin = new ProgressBar(this);
        root.addView(spin, new FrameLayout.LayoutParams(dp(44), dp(44), Gravity.CENTER));
        // ⚠️ spin 故意**不**放进 chrome。
        // 显隐控件和「在不在缓冲」是两件事：缓冲圈该由 STATE_BUFFERING / STATE_READY
        // 单独控制。如果把它塞进 chrome，那单手点一下画面让它「显示控件」，
        // 就会顺带把一个转圈画上去 —— 看着像一直在加载。
        spin.setVisibility(View.GONE);

        // 中央大播放按钮（点画面也能暂停/播放，但 Xplayer 中间那个圆钮更好找）
        btnPlay = new android.widget.ImageView(this);
        btnPlay.setImageDrawable(new PlayPauseDrawable(false));
        btnPlay.setPadding(dp(20), dp(20), dp(20), dp(20));
        btnPlay.setBackground(roundRect(0x59000000, 100));
        btnPlay.setVisibility(View.GONE);
        btnPlay.setOnClickListener(v -> togglePlay());
        root.addView(btnPlay, new FrameLayout.LayoutParams(dp(72), dp(72), Gravity.CENTER));
        centerPlay = btnPlay;
    }

    private void buildBottomBar() {
        FrameLayout shadow = new FrameLayout(this);
        shadow.setBackground(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
                new int[]{0x80000000, 0x00000000}));

        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.HORIZONTAL);
        bottom.setGravity(Gravity.CENTER_VERTICAL);
        bottom.setPadding(dp(5), 0, dp(5), 0);

        // 播放/暂停
        android.widget.ImageView play = new android.widget.ImageView(this);
        play.setImageDrawable(new PlayPauseDrawable(false));
        play.setPadding(dp(8), dp(8), dp(8), dp(8));
        play.setOnClickListener(v -> togglePlay());
        bottom.addView(play, new LinearLayout.LayoutParams(dp(BTN), dp(BTN)));
        this.btnPlayBar = play;

        tvNow = new TextView(this);
        tvNow.setText("00:00");
        tvNow.setTextColor(Color.WHITE);
        tvNow.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        LinearLayout.LayoutParams nowLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        nowLp.leftMargin = dp(5);
        nowLp.rightMargin = dp(16);
        bottom.addView(tvNow, nowLp);

        bar = new SeekBar(this);
        bar.setMax(1000);
        barDraw = new GradientProgressDrawable();
        bar.setProgressDrawable(barDraw);
        bar.setThumb(thumbDrawable());
        bar.setSplitTrack(false);
        bar.setPadding(0, 0, 0, 0);
        LinearLayout.LayoutParams bLp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        bottom.addView(bar, bLp);
        bar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar sb, int p, boolean fromUser) {
                if (!fromUser) return;
                if (durationMs > 0) tvNow.setText(fmt((long) (durationMs * p / 1000.0)));
            }
            @Override public void onStartTrackingTouch(SeekBar sb) {
                dragging = true;
                showControls(true);
            }
            @Override public void onStopTrackingTouch(SeekBar sb) {
                dragging = false;
                if (durationMs > 0) {
                    seekTo((long) (durationMs * sb.getProgress() / 1000.0));
                } else if (player != null && player.getDuration() > 0) {
                    durationMs = player.getDuration();
                    tvAll.setText(fmt(durationMs));
                    seekTo((long) (durationMs * sb.getProgress() / 1000.0));
                }
                showControls(true);
            }
        });

        tvAll = new TextView(this);
        tvAll.setText("--:--");
        tvAll.setTextColor(Color.WHITE);
        tvAll.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        LinearLayout.LayoutParams allLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        allLp.leftMargin = dp(16);
        allLp.rightMargin = dp(5);
        bottom.addView(tvAll, allLp);

        // 全屏（切回网页那一套/退出）—— 保留它，因为它是「网页侧能力更强」时的逃生口
        TextView web = new TextView(this);
        web.setText("网页");
        web.setTextColor(Color.WHITE);
        web.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        web.setGravity(Gravity.CENTER);
        clickable(web, v -> fallbackToWeb());
        bottom.addView(web, new LinearLayout.LayoutParams(dp(BTN), dp(BTN)));

        FrameLayout.LayoutParams bLp2 = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(BAR_H), Gravity.BOTTOM);
        shadow.addView(bottom, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(BAR_H), Gravity.BOTTOM));
        bottomBar = bottom;

        root.addView(shadow, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(SHADOW_H), Gravity.BOTTOM));
        chrome.add(shadow);
    }

    private void buildGesturePanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setBackground(roundRect(C_GESTURE_BG, 8));

        gestureIcon = new android.widget.ImageView(this);
        panel.addView(gestureIcon, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        gestureText = new TextView(this);
        gestureText.setTextColor(Color.WHITE);
        gestureText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        gestureText.setText("00:00/00:00");
        LinearLayout.LayoutParams gtLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        gtLp.topMargin = dp(8);
        panel.addView(gestureText, gtLp);

        gestureProgress = new ProgressBar(this, null,
                android.R.attr.progressBarStyleHorizontal);
        gestureProgress.setMax(100);
        gestureProgress.setProgressDrawable(new PlainBarDrawable());
        gestureProgress.setVisibility(View.GONE);
        LinearLayout.LayoutParams gpLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3));
        gpLp.topMargin = dp(16);
        gpLp.leftMargin = dp(12);
        gpLp.rightMargin = dp(12);
        panel.addView(gestureProgress, gpLp);

        gesturePanel = panel;
        gesturePanel.setVisibility(View.GONE);

        // Xplayer 横屏下是 168×99dp
        root.addView(gesturePanel, new FrameLayout.LayoutParams(dp(168), dp(99), Gravity.CENTER));
    }

    private void buildCompletion() {
        // 用 WRAP_CONTENT + 居中放，别用 MATCH_PARENT。
        // LinearLayout 的 gravity 只管**子view之间**怎么排，撑满宽度时那行文字会被拉到最左，
        // 而按钮因为自带 padding 看起来还是居中的 —— 上一版就是这个现象（文字贴左、按钮居中）。
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.setPadding(dp(28), dp(20), dp(28), dp(20));
        box.setBackground(roundRect(0xF2000000, 8));
        box.setVisibility(View.GONE);

        TextView t1 = new TextView(this);
        t1.setText("播放完了");
        t1.setTextColor(Color.WHITE);
        t1.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        box.addView(t1);

        TextView again = new TextView(this);
        again.setText("重播");
        again.setTextColor(Color.WHITE);
        again.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        again.setGravity(Gravity.CENTER);
        again.setPadding(dp(22), dp(8), dp(22), dp(8));
        again.setBackground(roundRect(C_STYLE, 22));
        LinearLayout.LayoutParams aLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        aLp.topMargin = dp(16);
        aLp.gravity = Gravity.CENTER_HORIZONTAL;
        again.setOnClickListener(v -> {
            completionView.setVisibility(View.GONE);
            if (player != null) { player.seekTo(0); player.play(); }
        });
        box.addView(again, aLp);

        completionView = box;
        // 同 spin：完成页不能进 chrome，否则单击画面显控件时会把「播放完了」又画出来。
        root.addView(box, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER));
    }

    /** 点击用的辅助方法（尺寸/位置由调用方自己 addView 时决定，这里只管可点） */
    private void clickable(View v, View.OnClickListener l) {
        v.setOnClickListener(l);
        v.setClickable(true);
    }

    /** Xplayer 的圆角实心块（相当于它的 player_gesture_content_bg 那些 shape） */
    private GradientDrawable roundRect(int color, float radius) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(radius));
        return d;
    }

    private GradientDrawable thumbDrawable() {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(Color.WHITE);
        d.setSize(dp(10), dp(10));
        return d;
    }

    private void applyImmersive() {
        View d = getWindow().getDecorView();
        int f = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
        d.setSystemUiVisibility(f);
    }

    // ------------------------------------------------------------------ 播放器

    private void buildPlayer() {
        // 关掉没用的扩展渲染器，省 apk 也省启动时间（本来就只有 MediaCodec 渲染器）
        RenderersFactory rf = new DefaultRenderersFactory(this)
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF);
        trackSelector = new DefaultTrackSelector(this);
        player = new ExoPlayer.Builder(this, rf)
                .setTrackSelector(trackSelector)
                // 这里**故意不再传 ExtractorsFactory**，用 Media3 自带的 DefaultExtractorsFactory。
                // 曾经在 ExoPlayer 2.19.1 上踩过一个坑：那套 aar 是残缺的——
                // NalUnitUtil 被 mp4/mkv/flv 那一票 extractor 引用，却不在任何模块里，
                // 于是按扩展名分发时（.avi 也会去 new mp4 系）直接 NoClassDefFoundError 崩掉。
                // 当时用 NasExtractorsFactory 绕开，但代价是 MP4/MKV 播不了。
                // 换到 Media3 1.4.1 后 NalUnitUtil 老老实实待在 media3-container 里，
                // 官方默认工厂就是对的，绕行方案已删除（详见 SKILL.md 里那条记录）。
                .build();
        player.addListener(this);

        if (surfaceView instanceof android.view.TextureView) {
            player.setVideoTextureView((android.view.TextureView) surfaceView);
        } else {
            player.setVideoSurfaceView((android.view.SurfaceView) surfaceView);
        }
    }

    private void startPlayback(boolean encode) {
        if (player == null) return;
        String src = encode ? encUrl : url;
        if (src == null || src.isEmpty()) { fallbackToWeb(); return; }

        Log.i(TAG, "play " + src + " encode=" + encode + " software=" + tryingSoftware);
        spin.setVisibility(View.VISIBLE);
        completionView.setVisibility(View.GONE);
        tvCenterHint.setVisibility(View.GONE);
        prepared = false;
        durationMs = C.TIME_UNSET;

        MediaItem item = MediaItem.fromUri(Uri.parse(src));
        player.setMediaItem(item);
        player.setPlayWhenReady(true);
        player.prepare();
    }

    private void seekTo(long ms) {
        if (player == null) return;
        if (ms < 0) ms = 0;
        if (durationMs > 0 && ms > durationMs) ms = durationMs;
        player.seekTo(ms);
        if (durationMs > 0) {
            bar.setProgress((int) (1000L * ms / durationMs));
            tvNow.setText(fmt(ms));
        }
        spin.setVisibility(View.VISIBLE);   // seek 之后画面会闪一下，给个圈
    }

    private void togglePlay() {
        if (player == null || !prepared) return;
        if (player.isPlaying()) {
            player.pause();
        } else {
            if (player.getPlaybackState() == Player.STATE_ENDED) player.seekTo(0);
            player.play();
        }
        showControls(true);
    }

    /** 切换缩放模式：原始比例 → 拉伸铺满 → 裁剪填满 */
    private void cycleResize(TextView label) {
        if (resizeMode == AspectRatioFrameLayout.RESIZE_MODE_FIT) {
            resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FILL;
            label.setText("铺满");
        } else if (resizeMode == AspectRatioFrameLayout.RESIZE_MODE_FILL) {
            resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM;
            label.setText("裁剪");
        } else {
            resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT;
            label.setText("缩放");
        }
        aspectBox.setResizeMode(resizeMode);
        showControls(true);
    }

    // ------------------------------------------------------------------ ExoPlayer 回调

    @Override public void onPlaybackStateChanged(int state) {
        switch (state) {
            case Player.STATE_BUFFERING:
                spin.setVisibility(View.VISIBLE);
                break;
            case Player.STATE_READY:
                spin.setVisibility(View.GONE);
                prepared = true;
                durationMs = player.getDuration();
                if (durationMs > 0) tvAll.setText(fmt(durationMs));
                // 起播位置只认一次。
                // ⚠️ STATE_READY 在一次播放里会反复回到（缓冲、seek 完都会再进一次），
                //    所以这里必须靠 startSec>0 自己把自己清成 0 来「只消费一次」——
                //    否则每次缓冲回来都把用户拽回片头，看着就是「播着播着跳回开头」。
                if (startSec > 0) {
                    player.seekTo(startSec * 1000L);
                    startSec = 0;
                }
                showControls(true);
                ui.removeCallbacks(tick);
                ui.post(tick);
                break;
            case Player.STATE_ENDED:
                spin.setVisibility(View.GONE);
                completionView.setVisibility(View.VISIBLE);
                showControls(true);
                break;
            default:
                break;
        }
    }

    @Override public void onIsPlayingChanged(boolean playing) {
        updatePlayIcon();
        if (playing) {
            completionView.setVisibility(View.GONE);
            ui.removeCallbacks(hideCtl);
            ui.postDelayed(hideCtl, HIDE_DELAY);
        }
    }

    @Override public void onVideoSizeChanged(VideoSize size) {
        videoW = size.width;
        videoH = size.height;
        // AspectRatioFrameLayout 自己会算比例，这里只把内容比例告诉它
        if (videoW > 0 && videoH > 0) {
            aspectBox.setAspectRatio(videoH == 0 ? 0f : (float) videoW * size.pixelWidthHeightRatio / videoH);
        }
        /* 画面比例就是方向的判据：宽 > 高 = 横屏片，高 > 宽 = 竖屏片。
           ⚠️ 手机竖拍的片子经常是「1920x1080 + 一个 90° 旋转标记」，
              这种 `width/height` 是**旋转前**的，直接比会把竖屏判成横屏 ——
              所以 `unappliedRotationDegrees` 是 90/270 时先把宽高对调。 */
        int w = videoW, h = videoH;
        if (size.unappliedRotationDegrees % 180 != 0) { int t = w; w = h; h = t; }
        if (w > 0 && h > 0) {
            int want = w > h ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                             : ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT;
            if (want != appliedOrientation) {      // 只在真的变了才调，避免来回闪
                appliedOrientation = want;
                setRequestedOrientation(want);
                Log.i(TAG, "按画面比例定方向 " + w + "x" + h
                        + (w > h ? "（横屏片）" : "（竖屏片）"));
            }
        }
        Log.i(TAG, "画面 " + videoW + "x" + videoH);
    }

    @Override public void onPlayerError(PlaybackException error) {
        Log.e(TAG, "播放错误 " + error.getErrorCodeName() + " encode=" + triedEncode
                + " software=" + tryingSoftware, error);
        spin.setVisibility(View.GONE);

        // ① 直连失败 → 换重编码流试一次
        if (!triedEncode && encUrl != null && !encUrl.isEmpty()) {
            triedEncode = true;
            toast("直连播不动，改用重编码流");
            startPlayback(true);
            return;
        }
        /* ①② 之间先兜「上游临时抽风」。
         * 🔴 为什么要单独兜（2026-09-19 实测）：源是 115 这类网盘时，
         *    直链会被风控 —— 同一个地址这一秒 403、下一秒就 206（连续打 6 次全 206）。
         *    而这种 IO 错误原本**一次都不重试**，直接把错误甩给用户，
         *    看起来就是「这台机器播不了」。
         * ⚠️ 只对网络类错误重试，且次数封顶 —— 文件真不存在（404）重试多少次都没用，
         *    解码失败也不是重试能治的，那些交给后面的分支。 */
        boolean transientIo = error.errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS
                || error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                || error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT
                || error.errorCode == PlaybackException.ERROR_CODE_TIMEOUT;
        if (transientIo && ioRetry < 3) {
            ioRetry++;
            /* 指数退避（2s → 4s → 8s），别用固定 1.5 秒 —— 实测撞上时是 115 的限流窗口，
               窗口没过去之前重试多少次都是 403，白等还白白多挨一次风控。 */
            long wait = 1000L * (1L << ioRetry);
            Log.w(TAG, "上游临时拒绝（" + error.getErrorCodeName() + "），"
                    + wait + "ms 后重试第 " + ioRetry + " 次");
            /* 🔴 重试期间必须留一个**常驻**浮层：否则黑屏 2~8 秒，用户以为卡死
               （「打开直接卡死根本用不了」的真相 —— 其实在重试，只是没反馈）。
               文字随次数更新 = 一眼就知道还活着；startPlayback 触发时会自己清掉它。 */
            showRetryHint(ioRetry, wait);
            ui.postDelayed(() -> startPlayback(triedEncode), wait);
            return;
        }
        // ② 硬件解码器不吃这个编码 → 关掉「只信硬件」再试一次
        //    （只是放宽 MediaCodec 的选择范围，不是搬了软解进来）
        boolean decoderTrouble = error.errorCode == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED
                || error.errorCode == PlaybackException.ERROR_CODE_DECODING_FAILED
                || error.errorCode == PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED;
        if (!tryingSoftware && decoderTrouble) {
            tryingSoftware = true;
            toast("硬解不吃，放宽解码器限制再试");
            rebuildPlayerRelaxed();
            startPlayback(triedEncode);
            return;
        }
        /* ③ 放宽之后还是解码不了 → 这台设备就是解不了它。
         * 🔴 不再停在「点这里用网页播放器再试一次」的报错界面（2026-09-20 用户要求）：
         *    抖音式刷片的语境里，用户对一条播不了的片子没有任何留恋，
         *    停下来等点击 = 打断刷片的节奏。直接退回信息流，由页面自动滑到下一条
         *    （finish 走 RESULT_FALLBACK → window.__nasFallback → scrollBy(1)）。
         * ⚠️ 只对**解码类**错误这样做；取不到流（404/超时）仍然保留报错界面 ——
         *    那些可能是网络问题，提示「为什么播不了」比静默跳过更负责任。 */
        if (decoderTrouble) {
            Log.w(TAG, "解码器放宽后仍然失败，自动跳过：" + title);
            toast("这部片这台设备解不了，已自动跳过");
            fallbackToWeb();
            return;
        }
        showError(error);
    }

    /** 重建一个「允许软件解码器」的播放器实例（ExoPlayer 的选项在 Builder 时就定死了） */
    private void rebuildPlayerRelaxed() {
        long pos = player == null ? 0 : Math.max(0, player.getCurrentPosition());
        if (player != null) { player.removeListener(this); player.release(); player = null; }
        RenderersFactory rf = new DefaultRenderersFactory(this)
                .setEnableDecoderFallback(true)      // 硬件不行就换下一个（含系统软解）
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF);
        player = new ExoPlayer.Builder(this, rf)
                .setTrackSelector(trackSelector)
                .build();
        player.addListener(this);
        if (surfaceView instanceof android.view.TextureView) {
            player.setVideoTextureView((android.view.TextureView) surfaceView);
        } else {
            player.setVideoSurfaceView((android.view.SurfaceView) surfaceView);
        }
        startSec = (int) (pos / 1000);
    }

    private void showError(PlaybackException e) {
        String why = "这个视频播不出来";
        int code = e.errorCode;
        if (code == PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND
                || code == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS) {
            why = "取不到视频流（服务端没给或者地址失效）";
        } else if (code == PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED
                || code == PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED) {
            why = "文件封装坏了，解不开";
        } else if (code == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED
                || code == PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED) {
            why = "不认这种封装";
        } else if (code == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED
                || code == PlaybackException.ERROR_CODE_DECODING_FAILED
                || code == PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED) {
            // 这一条要说实话：ExoPlayer 只管解封装，解码仍然交给系统 MediaCodec
            why = "这台设备没有能解它的解码器";
        } else if (code == PlaybackException.ERROR_CODE_TIMEOUT) {
            why = "连接超时";
        }
        tvCenterHint.setText(why + "\n点这里用网页播放器再试一次");
        tvCenterHint.setVisibility(View.VISIBLE);
        showControls(true);
    }

    /** 上游临时限流时的「正在重试」常驻浮层（解决「黑屏以为卡死」）。
     *  spinner 和文字会居中重叠，所以用文字代替转圈；文字带「第 N/3 次」会随重试更新，
     *  一眼就知道播放器还活着、在忙，不是卡死。startPlayback 触发时由它自己清掉。 */
    private void showRetryHint(int n, long waitMs) {
        spin.setVisibility(View.GONE);
        tvCenterHint.setText("115 正在限流，第 " + n + "/3 次自动重试中…\n（约 " + (waitMs / 1000) + " 秒后）");
        tvCenterHint.setVisibility(View.VISIBLE);
    }

    @Override public void onPlayerErrorChanged(PlaybackException error) { }

    // ------------------------------------------------------------------ 进度 tick

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (player != null && prepared && !dragging) {
                long d = player.getDuration();
                if (d > 0 && d != durationMs) {
                    durationMs = d;
                    tvAll.setText(fmt(d));
                }
                if (durationMs > 0) {
                    long p = Math.max(0, player.getCurrentPosition());
                    bar.setProgress((int) (1000L * p / durationMs));
                    tvNow.setText(fmt(p));
                    // 缓冲进度也画出来（Xplayer 的 secondaryProgress 那一层）。
                    // SeekBar 会自己存这个值并回调 drawable 重绘，不用手动转发。
                    long buf = player.getBufferedPosition();
                    if (buf < 0) buf = 0;
                    if (barDraw != null) {
                        barDraw.setSecondary((int) (1000L * Math.min(buf, durationMs) / durationMs));
                    }
                }
            }
            ui.postDelayed(this, 400);
        }
    };

    // ------------------------------------------------------------------ 手势

    /** 横向 seek / 左右半边定音量亮度 —— 规则照抄 Xplayer 的 GestureController */
    private boolean onTouch(MotionEvent e) {
        final int w = root.getWidth() > 0 ? root.getWidth() : 1;
        final int h = root.getHeight() > 0 ? root.getHeight() : 1;
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = e.getX(); downY = e.getY();
                mode = MODE_NONE;
                seekBaseMs = player == null ? 0 : (int) Math.max(0, player.getCurrentPosition());
                seekTargetMs = -1;
                maxVolume = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                baseVolume = audio.getStreamVolume(AudioManager.STREAM_MUSIC);
                baseBrightness = getWindow().getAttributes().screenBrightness;
                break;

            case MotionEvent.ACTION_MOVE: {
                float dx = e.getX() - downX;
                float dy = e.getY() - downY;
                if (mode == MODE_NONE) {
                    if (Math.abs(dx) < dp(8) && Math.abs(dy) < dp(8)) break;
                    ui.removeCallbacks(singleTap);       // 判定为滑动，不当点击
                    // 横滑优先认 seek；否则看手指在左半屏还是右半屏
                    if (Math.abs(dx) >= Math.abs(dy)) {
                        mode = MODE_SEEK;
                    } else {
                        mode = (downX > w / 2f) ? MODE_VOLUME : MODE_BRIGHT;
                    }
                    showGesturePanel();
                }
                if (mode == MODE_SEEK) {
                    int target = (int) clamp(seekBaseMs + (long) (dx / w * SEEK_FULL_MS),
                            0, durationMs > 0 ? durationMs : Integer.MAX_VALUE);
                    seekTargetMs = target;
                    gestureIcon.setImageDrawable(new ArrowDrawable(true, Color.WHITE));
                    gestureText.setVisibility(View.VISIBLE);
                    gestureProgress.setVisibility(View.GONE);
                    gestureText.setText(fmt(target) + "/" + (durationMs > 0 ? fmt(durationMs) : "--:--"));
                } else if (mode == MODE_VOLUME) {
                    int delta = (int) (-dy * 2 / h * maxVolume);
                    int idx = (int) clamp(baseVolume + delta, 0, maxVolume);
                    audio.setStreamVolume(AudioManager.STREAM_MUSIC, idx, 0);
                    showPercent(idx * 100 / Math.max(1, maxVolume), true);
                } else if (mode == MODE_BRIGHT) {
                    float bb = baseBrightness < 0 ? 0.5f : baseBrightness;
                    float nb = bb + (-dy) * 2 / h;
                    nb = nb < 0 ? 0 : (nb > 1 ? 1 : nb);
                    WindowManager.LayoutParams lp = getWindow().getAttributes();
                    lp.screenBrightness = nb;
                    getWindow().setAttributes(lp);
                    showPercent((int) (nb * 100), false);
                }
                break;
            }

            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL: {
                if (mode != MODE_NONE) {
                    if (mode == MODE_SEEK && seekTargetMs >= 0) seekTo(seekTargetMs);
                    hideGesturePanel();
                    showControls(true);
                } else {
                    long now = System.currentTimeMillis();
                    if (now - lastTapMs < 280) {
                        lastTapMs = 0;
                        ui.removeCallbacks(singleTap);
                        togglePlay();                    // 双击：暂停/播放
                    } else {
                        lastTapMs = now;
                        // 不在这里直接 toggleControls：单击/双击要靠 280ms 去区分，
                        // 必须等这个窗口过去才敢认为是单击。
                        ui.postDelayed(singleTap, 280);
                    }
                }
                mode = MODE_NONE;
                seekTargetMs = -1;
                break;
            }
        }
        return true;
    }

    private void showGesturePanel() {
        // 手指又动了：把上一次「淡出」动画掐掉，否则它的回调会把面板收走
        gesturePanel.animate().cancel();
        gesturePanel.setVisibility(View.VISIBLE);
        gesturePanel.setAlpha(1f);
    }

    private void hideGesturePanel() {
        // 淡出完直接收起来。这里**不能**加 `if (mode == MODE_NONE)` 之类的守卫：
        // mode 在 ACTION_UP 里很快就被清成 MODE_NONE 了，守卫只会让面板永远收不掉。
        // 真正要防的「动画还没跑完就来了新手势」由 showGesturePanel 里的 cancel() 解决。
        gesturePanel.animate().alpha(0f).setDuration(250)
                .withEndAction(() -> gesturePanel.setVisibility(View.GONE))
                .start();
    }

    private void showPercent(int percent, boolean volume) {
        gestureIcon.setImageDrawable(new VolumeBrightDrawable(volume));
        gestureText.setVisibility(View.GONE);
        gestureProgress.setVisibility(View.VISIBLE);
        gestureProgress.setProgress(Math.max(0, Math.min(100, percent)));
    }

    private void toggleControls() {
        // ⚠️ 这里必须读 **chrome 里的那个 view**，不能读 bottomBar。
        //    血泪教训：bottomBar 是 shadow(FrameLayout) 的**子**view，而进 chrome 的是 shadow。
        //    showControls() 只把 shadow 设成 GONE，bottomBar 自己的 visibility 一直是 VISIBLE，
        //    于是上一版这里永远算出「当前是显示中」→ 每次单击都在关控件、永远开不出来。
        //    现象极具迷惑性：日志里两行挨着看，明明写的是 GONE，判断却说是 VISIBLE。
        View probe = chrome.isEmpty() ? null : chrome.get(chrome.size() - 1);
        boolean vis = probe != null && probe.getVisibility() == View.VISIBLE;
        showControls(!vis);
    }

    private void showControls(boolean show) {
        ui.removeCallbacks(hideCtl);
        for (View v : chrome) {
            if (v == centerPlay) continue;             // 中键单独管
            v.setVisibility(show ? View.VISIBLE : View.GONE);
        }
        // 中央播放按钮：暂停时才露出来
        boolean paused = player == null || !player.isPlaying();
        centerPlay.setVisibility(show && paused && prepared
                && completionView.getVisibility() != View.VISIBLE ? View.VISIBLE : View.GONE);
        if (show) ui.postDelayed(hideCtl, HIDE_DELAY);
    }

    private final Runnable hideCtl = () -> showControls(false);

    // ------------------------------------------------------------------ 退出

    private void fallbackToWeb() {
        fallback = true;
        finish();
    }

    @Override public void finish() {
        if (fallback) {
            setResult(RESULT_FALLBACK);
        } else {
            Intent out = new Intent();
            out.putExtra(EX_POS, (int) (currentPos() / 1000));
            if (path != null) out.putExtra(EX_PATH, path);
            setResult(RESULT_OK, out);
        }
        super.finish();
    }

    private long currentPos() {
        if (player == null) return 0;
        long p = player.getCurrentPosition();
        return p < 0 ? 0 : p;
    }

    @Override protected void onPause() {
        super.onPause();
        if (player != null) player.pause();
    }

    @Override protected void onResume() {
        super.onResume();
        applyImmersive();
        if (player != null && prepared) player.play();
    }

    @Override protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        if (player != null) {
            player.removeListener(this);
            player.release();
            player = null;
        }
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        finish();
    }

    // ------------------------------------------------------------------ 自绘 drawable
    // 这些都是替 Xplayer 里对应的 xml drawable（gradient / shape / selector）。
    // 用自绘而不是加资源文件，是因为这个项目没有 aapt2 之外的资源处理链，
    // 而且直接画能少掉一堆 png。

    /**
     * 进度条：底轨 33FFFFFF → 缓冲 66FFFFFF → 已播 #37CAF9→#1DBA5B 渐变
     * （照抄 Xplayer 的 player_seek_progress.xml）
     *
     * ⚠️ onLevelChange 只会被喂**主进度**（level = progress*10000/max），
     *    缓冲那一层系统是单独回调的、不会走到这儿。所以缓冲比例得让 SeekBar
     *    自己存（见 setSecondary），别指望在这层拿到。
     */
    private class GradientProgressDrawable extends android.graphics.drawable.Drawable {
        private final android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        private int p = 0, sec = 0;

        @Override public void draw(android.graphics.Canvas c) {
            float h = getBounds().height();
            float y = getBounds().centerY();
            float r = dp(2);
            float w = getBounds().width();
            float cx = (p / 1000f) * w;
            float sx = (sec / 1000f) * w;

            paint.setShader(null);
            paint.setColor(C_TRACK);
            c.drawRoundRect(0, y - dp(1), w, y + dp(1), r, r, paint);

            if (sx > cx) {
                paint.setColor(C_BUFFERED);
                c.drawRoundRect(cx, y - dp(1), sx, y + dp(1), r, r, paint);
            }
            if (cx > 0) {
                paint.setShader(new android.graphics.LinearGradient(
                        0, 0, w, 0, C_GRAD_START, C_GRAD_END, android.graphics.Shader.TileMode.CLAMP));
                c.drawRoundRect(0, y - dp(1), cx, y + dp(1), r, r, paint);
                paint.setShader(null);
            }
        }

        @Override public void setAlpha(int a) { }
        @Override public void setColorFilter(android.graphics.ColorFilter f) { }
        @Override public int getOpacity() { return android.graphics.PixelFormat.TRANSLUCENT; }
        @Override public boolean isStateful() { return true; }
        @Override protected boolean onLevelChange(int level) {
            // 0..10000，映射回 0..1000 的「千分比」，和 setSecondary 同一把尺子
            p = level / 10; invalidateSelf(); return true;
        }
        /** 由 SeekBar 那边算好千分比塞进来（0..1000） */
        public void setSecondary(int v) { sec = v; invalidateSelf(); }
    }

    /** 手势面板里那根细条（player_gesture_regulate_progress.xml） */
    private class PlainBarDrawable extends android.graphics.drawable.Drawable {
        private final android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        private int p = 0;

        @Override public void draw(android.graphics.Canvas c) {
            float y = getBounds().centerY(), w = getBounds().width(), r = dp(2);
            float cx = (p / 100f) * w;
            paint.setShader(null);
            paint.setColor(C_GESTURE_TRACK);
            c.drawRoundRect(0, y - dp(1.2f), w, y + dp(1.2f), r, r, paint);
            paint.setShader(new android.graphics.LinearGradient(
                    0, 0, w, 0, C_GRAD_START, C_GRAD_END, android.graphics.Shader.TileMode.CLAMP));
            c.drawRoundRect(0, y - dp(1.2f), cx, y + dp(1.2f), r, r, paint);
            paint.setShader(null);
        }

        @Override public void setAlpha(int a) { }
        @Override public void setColorFilter(android.graphics.ColorFilter f) { }
        @Override public int getOpacity() { return android.graphics.PixelFormat.TRANSLUCENT; }
        @Override protected boolean onLevelChange(int level) { p = level; invalidateSelf(); return true; }
    }

    /** 播放/暂停三角与双竖线（Xplayer 用 ic_player_play / ic_player_pause 两个 png） */
    private class PlayPauseDrawable extends android.graphics.drawable.Drawable {
        private final android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        private final boolean playing;

        PlayPauseDrawable(boolean playing) {
            this.playing = playing;
            paint.setColor(Color.WHITE);
            paint.setStyle(android.graphics.Paint.Style.FILL);
        }

        @Override public void draw(android.graphics.Canvas c) {
            android.graphics.Rect b = getBounds();
            float cx = b.exactCenterX(), cy = b.exactCenterY();
            float s = Math.min(b.width(), b.height()) * 0.30f;
            android.graphics.Path path = new android.graphics.Path();
            if (playing) {                                  // 暂停：两条竖条
                c.drawRect(cx - s * 0.85f, cy - s, cx - s * 0.25f, cy + s, paint);
                c.drawRect(cx + s * 0.25f, cy - s, cx + s * 0.85f, cy + s, paint);
            } else {                                        // 播放：三角
                path.moveTo(cx - s * 0.72f, cy - s);
                path.lineTo(cx + s * 0.85f, cy);
                path.lineTo(cx - s * 0.72f, cy + s);
                path.close();
                c.drawPath(path, paint);
            }
        }

        @Override public void setAlpha(int a) { paint.setAlpha(a); }
        @Override public void setColorFilter(android.graphics.ColorFilter f) { paint.setColorFilter(f); }
        @Override public int getOpacity() { return android.graphics.PixelFormat.TRANSLUCENT; }
    }

    /** 手势面板里的快进/快退箭头 */
    private class ArrowDrawable extends android.graphics.drawable.Drawable {
        private final android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        private final boolean forward;

        ArrowDrawable(boolean forward, int color) {
            this.forward = forward;
            paint.setColor(color);
            paint.setStrokeWidth(dp(2));
            paint.setStyle(android.graphics.Paint.Style.STROKE);
            paint.setStrokeCap(android.graphics.Paint.Cap.ROUND);
        }

        @Override public void draw(android.graphics.Canvas c) {
            android.graphics.Rect b = getBounds();
            float cx = b.exactCenterX(), cy = b.exactCenterY();
            float s = Math.min(b.width(), b.height()) * 0.26f;
            android.graphics.Path p = new android.graphics.Path();
            if (forward) {
                p.moveTo(cx - s * .2f, cy - s); p.lineTo(cx + s * .75f, cy); p.lineTo(cx - s * .2f, cy + s);
            } else {
                p.moveTo(cx + s * .2f, cy - s); p.lineTo(cx - s * .75f, cy); p.lineTo(cx + s * .2f, cy + s);
            }
            c.drawPath(p, paint);
        }

        @Override public void setAlpha(int a) { }
        @Override public void setColorFilter(android.graphics.ColorFilter f) { }
        @Override public int getOpacity() { return android.graphics.PixelFormat.TRANSLUCENT; }
    }

    /** 手势面板里的音量/亮度小图标 */
    private class VolumeBrightDrawable extends android.graphics.drawable.Drawable {
        private final android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        private final boolean volume;

        VolumeBrightDrawable(boolean volume) {
            this.volume = volume;
            paint.setColor(Color.WHITE);
            paint.setStyle(android.graphics.Paint.Style.FILL);
        }

        @Override public void draw(android.graphics.Canvas c) {
            android.graphics.Rect b = getBounds();
            float cx = b.exactCenterX(), cy = b.exactCenterY();
            float s = Math.min(b.width(), b.height()) * 0.24f;
            if (volume) {                                     // 喇叭
                android.graphics.Path p = new android.graphics.Path();
                p.moveTo(cx - s, cy - s * .45f);
                p.lineTo(cx - s * .45f, cy - s * .45f);
                p.lineTo(cx + s * .1f, cy - s * 1.05f);
                p.lineTo(cx + s * .1f, cy + s * 1.05f);
                p.lineTo(cx - s * .45f, cy + s * .45f);
                p.lineTo(cx - s, cy + s * .45f);
                p.close();
                c.drawPath(p, paint);
                paint.setStyle(android.graphics.Paint.Style.STROKE);
                paint.setStrokeWidth(dp(1.6f));
                android.graphics.RectF r = new android.graphics.RectF(
                        cx + s * .1f, cy - s * .85f, cx + s * 1.6f, cy + s * .85f);
                c.drawArc(r, -55, 110, false, paint);
                paint.setStyle(android.graphics.Paint.Style.FILL);
            } else {                                          // 太阳
                c.drawCircle(cx, cy, s * .52f, paint);
                paint.setStyle(android.graphics.Paint.Style.STROKE);
                paint.setStrokeWidth(dp(1.6f));
                for (int i = 0; i < 8; i++) {
                    double a = Math.PI * i / 4;
                    c.drawLine(cx + (float) Math.cos(a) * s * .82f, cy + (float) Math.sin(a) * s * .82f,
                            cx + (float) Math.cos(a) * s * 1.25f, cy + (float) Math.sin(a) * s * 1.25f, paint);
                }
                paint.setStyle(android.graphics.Paint.Style.FILL);
            }
        }

        @Override public void setAlpha(int a) { }
        @Override public void setColorFilter(android.graphics.ColorFilter f) { }
        @Override public int getOpacity() { return android.graphics.PixelFormat.TRANSLUCENT; }
    }

    // ------------------------------------------------------------------ 小工具

    private void updatePlayIcon() {
        boolean playing = player != null && player.isPlaying();
        if (btnPlayBar != null) btnPlayBar.setImageDrawable(new PlayPauseDrawable(playing));
        if (btnPlay != null) btnPlay.setImageDrawable(new PlayPauseDrawable(playing));
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }

    private long clamp(long v, long lo, long hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    private String fmt(long ms) {
        if (ms < 0) ms = 0;
        long total = ms / 1000;
        long h = total / 3600, m = (total % 3600) / 60, s = total % 60;
        if (h > 0) return String.format("%d:%02d:%02d", h, m, s);
        return String.format("%02d:%02d", m, s);
    }
}
