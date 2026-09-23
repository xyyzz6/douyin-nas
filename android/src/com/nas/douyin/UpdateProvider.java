package com.nas.douyin;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 极简 FileProvider（2026-09-23，应用内更新用）。
 *
 * <h3>为什么不用 androidx.core 的 FileProvider</h3>
 * 本项目**没有 Gradle**，第三方库全靠 `android/libs/` 手工铺开（build.js 展开 aar）。
 * 为了一个类引入整个 `androidx.core`（1MB+ 的 aar、还会拖进 annotation / lifecycle 等连锁依赖）
 * 不值当 —— 这个类总共不到 80 行，逻辑还完全可控。
 *
 * <h3>它解决什么问题</h3>
 * Android 8.0（API 26）起，App **不能**把一个 `file://` 路径的 Uri 交给别的 App
 * （这里是系统安装器），会抛 `FileUriExposedException` 直接崩。
 * 必须给自己的文件发一个 `content://` Uri，并**只在这一条 Intent 上**临时授权读权限。
 *
 * <h3>🔴 安全边界（别为了省事放宽）</h3>
 * `openFile()` 里只放行**下载目录（cacheDir/update）内的文件**。若不校验，
 * 任何拿到 `content://com.nas.douyin.update/..%2F..%2Fshared_prefs%2Fnasdy.xml`
 * 这种构造路径的 App 都能读到本应用的私有文件（WebDAV 明文密码就在 nasdy.xml 里）。
 * 校验方式是 `getCanonicalPath()` 前缀比对 —— 用 canonical 而不是普通 path，
 * 因为前者会把 `..` 和软链接都解析掉，普通 path 能被 `..` 绕过。
 *
 * ⚠️ authorities 必须与 AndroidManifest 的 `<provider>` 和 MainActivity 里
 *    `getUriForFile` 的第二参数三处一致。
 */
public class UpdateProvider extends ContentProvider {

    /** 与 AndroidManifest 的 android:authorities、MainActivity 里用的字符串保持一致 */
    public static final String AUTHORITY = "com.nas.douyin.update";

    @Override
    public boolean onCreate() {
        return true;
    }

    /**
     * 把 `content://com.nas.douyin.update/<相对路径>` 还原成一个真实文件，**并校验它在根目录内**。
     *
     * @return null 表示 Uri 不属于本 provider；抛 FileNotFoundException 表示越界或不存在
     */
    private File resolve(Uri uri) throws FileNotFoundException {
        if (!AUTHORITY.equals(uri.getAuthority())) return null;
        File root = getRoot();
        // 去掉前导斜杠：getPath() 会给 "/update.apk" 这种
        String rel = uri.getPath() == null ? "" : uri.getPath().replaceFirst("^/+", "");
        File f = new File(root, rel);
        try {
            String rootPath = root.getCanonicalPath();
            String filePath = f.getCanonicalPath();
            /* 🔴 必须带 File.separator 一起比，否则 /foo/bar-evil 会被判成在 /foo/bar 内 */
            if (!filePath.equals(rootPath) && !filePath.startsWith(rootPath + File.separator)) {
                throw new FileNotFoundException("越界访问被拒绝：" + uri);
            }
        } catch (java.io.IOException e) {
            throw new FileNotFoundException("路径解析失败：" + e.getMessage());
        }
        if (!f.exists()) throw new FileNotFoundException("文件不存在：" + f.getName());
        return f;
    }

    /** 唯一放行的根目录 = cacheDir/update（与 res/xml/update_paths.xml 对应） */
    private File getRoot() {
        File dir = new File(getContext().getCacheDir(), "update");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = resolve(uri);
        if (f == null) throw new FileNotFoundException("不是本 provider 的 Uri：" + uri);
        /* 只读：安装器不需要写权限，写模式一律拒绝（少开一扇门） */
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    /**
     * 让系统安装器能显示文件名 / 大小（它在解析 APK 前会先 query 一下）。
     * 不实现这个方法**不会报错**，但安装界面可能显示成一串乱码路径名。
     */
    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        File f;
        try {
            f = resolve(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        if (f == null) return null;
        String[] cols = projection != null ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor cur = new MatrixCursor(cols, 1);
        MatrixCursor.RowBuilder row = cur.newRow();
        for (String c : cols) {
            if (OpenableColumns.DISPLAY_NAME.equals(c)) row.add(f.getName());
            else if (OpenableColumns.SIZE.equals(c)) row.add(f.length());
            else row.add(null);
        }
        return cur;
    }

    @Override
    public String getType(Uri uri) {
        String ext = MimeTypeMap.getFileExtensionFromUrl(uri.toString());
        String mime = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        return mime != null ? mime : "application/octet-stream";
    }

    // ---- 本 provider 只读，下面几个写操作一律不支持 ----

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("只读 provider");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("只读 provider");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("只读 provider");
    }
}
