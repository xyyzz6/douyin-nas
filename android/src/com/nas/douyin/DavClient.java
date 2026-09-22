package com.nas.douyin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

import javax.net.ssl.HttpsURLConnection;

/**
 * 极简 WebDAV 客户端：手机直接连 NAS，不再经过电脑上的 Node 服务。
 *
 * 只做两件事，够本 App 用：
 *   1) propfind() —— PROPFIND 列目录，解析出文件/子目录 + 大小 + 修改时间；
 *   2) 拼接出带 Basic Auth 的直接播放 URL（前端 <video>/原生播放器直接拉流）。
 *
 * 全部用 JDK 自带 HttpURLConnection，零第三方依赖，能被无 Gradle 的打包流程直接编译。
 */
public final class DavClient {

    /** 一次 WebDAV 目录项 */
    public static class Entry {
        public String href;      // 相对 WebDAV 根的路径，如 /video/a.mp4
        public String name;      // 显示名
        public boolean isDir;
        public long size;        // 字节；目录为 0
        public long mtime;       // 毫秒时间戳；没有则为 0

        public String ext() {
            int i = name.lastIndexOf('.');
            return i < 0 ? "" : name.substring(i + 1).toLowerCase();
        }
    }

    private final String base;       // 如 http://192.168.1.100:5005 或 http://IP:19798/dav
    private final String basePrefix; // base 里那段路径，如 "/dav"；根挂载时是 ""
    private final String auth;       // "Basic xxx" 或 null

    public DavClient(String url, String user, String pass) {
        String b = url == null ? "" : url.trim();
        // ⚠️ 顺序很关键：**先**砍尾斜杠、**再**取 path（basePrefix）。
        // 反过来的话 `http://IP:19798/dav/` 取到的 prefix 是 `/dav/`（带尾斜杠），
        // 而 base 砍完是 `http://IP:19798/dav`，relOf 里 `p.equals("/dav/")` 永不成立
        // → `/dav` 原样传下去 → 拼成 `/dav/dav`。
        // 先砍再取，prefix 就是干净的 `/dav`，两边比较才对得上。
        // （只有主机名的情况：`http://IP:5005/` 砍完 prefix 的 getPath() 是 ""，
        //   也是对的 —— 「根挂载没有前缀」。）
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        this.base = b;
        this.basePrefix = pathOf(b);
        if (user != null && !user.isEmpty()) {
            String up = user + ":" + (pass == null ? "" : pass);
            this.auth = "Basic " + android.util.Base64.encodeToString(
                    up.getBytes(java.nio.charset.StandardCharsets.UTF_8), android.util.Base64.NO_WRAP);
        } else {
            this.auth = null;
        }
    }

    /**
     * 把路径补成完整的 http 地址（认证走 header，不内嵌进 URL）。
     *
     * ⚠️ 这里要处理「服务地址挂在子路径」的情况 —— `base` 可能带着一段路径：
     *    · CloudDrive2 的 WebDAV 在 `http://IP:19798/dav`
     *    · Nextcloud 在 `http://域名/remote.php/dav/files/用户名`
     *    · Alist 在 `http://IP:5244/dav`
     *    只有群晖那种「根目录就是 WebDAV」的场景（`:5005`）路径才恰好为空。
     *
     * 2026-09-18 修的坑：`NasServer.hrefToAbs()` 返回的路径**已经带着这段前缀**
     * （PROPFIND 的 href 本来就含 `/dav`），所以老的 `base + encPath(path)`
     * 会拼成 **`/dav/dav/xxx`** —— 双前缀，资源永远 404。
     * 反过来，如果路径**没带**前缀（用户手填的 dir、或老配置），又必须补上，
     * 否则会丢掉 `/dav` 打错地方。
     *
     * 所以规则是**幂等**的：带了就沿用，没带才补 —— 两种情况都能落到正确地址。
     * server.js 的 davUrlAbs() 用的是同一条规则，两边必须保持一致。
     * （有无一致靠 _tmp/urlparity.js 对拍：17 组用例，目录/文件两种语义都覆盖。）
     */
    public String absUrl(String path) {
        // 相对路径退化成 "/"（= 请求 base 自己那一层）时直接给 base：
        // `base + encPath("/")` 会得到 `…/dav/`，而 CD2 对 `/dav/` 回 301，
        // Location 只带路径不带主机名，跟着跳就废。`…/dav` 才是稳的。
        // 这与 server.js 的 davUrlAbs 一致 —— 那边有 `p !== urlPath` 挡着同一件事。
        String rel = relOf(path);
        if ("/".equals(rel) && !basePrefix.isEmpty()) return base;
        return base + encPath(rel);
    }

    /** 取 shell 里那段路径，**归一成「无尾斜杠」**：`/dav/` → `/dav`，`/` 或空 → `""` */
    private static String pathOf(String url) {
        try {
            String p = new java.net.URL(url).getPath();
            if (p == null) return "";
            while (p.endsWith("/")) p = p.substring(0, p.length() - 1);
            return p;
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * 把 absPath 归一到「相对 base」的形态：已经带 base 路径就削掉，没带就原样。
     *
     * ⚠️ 三个坑都踩过，别改回去：
     * 1. 「p 恰好等于前缀」要返回 **"/"**（= base 的根）。absUrl() 和 propfindPath()
     *    拿到 "/" 各有各的处理（前者直接返回 base，后者用 basePrefix），
     *    别在 relOf 里替它们决定 —— 在这里凑只会越凑越乱。
     * 2. 砍尾斜杠要在**构造 base 之后**再取 basePrefix —— 见构造里的注释。
     * 3. 尾斜杠信息这里**不要丢**：路径以 "/" 结尾时（目录）原样交给 encPath，
     *    由它决定保不保留（见那边的注释）。这里只归一前缀，不做取舍。
     *
     * 削前缀做了边界检查：`/dav` 只能匹配 `/dav` 或 `/dav/xxx`，
     * 不会把 `/davos` 误当成前缀。
     */
    private String relOf(String path) {
        String p = path == null ? "" : path.trim();
        if (!p.startsWith("/")) p = "/" + p;
        if (!basePrefix.isEmpty()) {
            if (p.equals(basePrefix) || p.equals(basePrefix + "/")) return "/";
            if (p.startsWith(basePrefix + "/")) return p.substring(basePrefix.length());
        }
        return p;
    }

    /**
     * 把相对路径按 URL 编码（保留 / 分隔符），并**规范化尾斜杠**。
     *
     * 三条规则，与 server.js 的 encPath 必须逐字对齐（有对拍脚本）：
     *   · 空串 / 就是 "/" → 返回 "/"（根目录自己）
     *   · 传入的 p 以 "/" 结尾 → 保留，返回 "…/"（目录形态）
     *   · 其余 → 返回 "…"（文件形态，**不**乱加尾斜杠）
     *
     * 以前无条件 `p.split("/")` 再把空段全丢掉，尾斜杠会被吃掉：
     * `encPath("/")` 得到 "/"（凑巧对），但 `encPath("")` 也得到 "/"，
     * 于 `relOf` 削完前缀返回空串时拼出 `…/dav/` —— 正好踩中 CD2 的 301。
     * 现在空串和 "/" 都明确落成 "/"，尾斜杠则原样保留，语义不再含糊。
     */
    static String encPath(String p) {
        String s = p == null ? "" : p;
        if (s.isEmpty() || "/".equals(s)) return "/";
        boolean dir = s.endsWith("/");
        StringBuilder sb = new StringBuilder();
        for (String seg : s.split("/")) {
            if (seg.isEmpty()) continue;
            sb.append('/');
            sb.append(java.net.URLEncoder.encode(seg).replace("+", "%20"));
        }
        if (sb.length() == 0) return "/";
        if (dir) sb.append('/');
        return sb.toString();
    }

    /**
     * 列目录。返回该目录下的所有条目（文件 + 子目录）。
     * depth 传 "0" 只列目录本身，"1" 列一层子项。
     *
     * ⚠️ 必须用 rawRequest() 而不是 HttpURLConnection：Android 的 HttpURLConnection
     * 对请求方法有白名单（OPTIONS/GET/HEAD/POST/PUT/DELETE/TRACE/PATCH），
     * setRequestMethod("PROPFIND") 直接抛 ProtocolException，请求根本发不出去 ——
     * 表现就是「一直连不上 NAS」，跟地址密码无关。
     */
    public List<Entry> propfind(String path, String depth) throws IOException {
        String body = "<?xml version=\"1.0\"?>\n" +
                "<d:propfind xmlns:d=\"DAV:\">" +
                "<d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop>" +
                "</d:propfind>";
        RawResp r = rawRequest("PROPFIND", propfindPath(path),
                new String[]{"Depth", depth == null ? "1" : depth, "Content-Type", "application/xml"},
                body.getBytes("UTF-8"));
        if (r.code >= 400) throw new IOException("WebDAV " + r.code + (r.body.isEmpty() ? "" : ": " + r.body.substring(0, Math.min(200, r.body.length()))));
        return parsePropfind(r.body);
    }

    /**
     * 算出 PROPFIND 要写进请求行的路径 —— 与 absUrl() 是同一套坐标（只差 origin）。
     *
     * ⚠️ 必须自己削前缀：rawRequest 只把 path 原样写进请求行，**不会**补 base。
     * 漏了这一步就会去请求 `/dav/dav/115open` → 404
     * （踩过的坑：absUrl 修好了、propfind 没跟上，表现是「登录能过、一列目录就空」）。
     *
     * ⚠️ 削完前缀还要**把 basePrefix 补回请求行** —— 这是最容易漏的一步：
     * relOf 削掉的前缀是给 `base` 用的，而这里构造的是「打到服务器上的完整路径」，
     * 前缀必须重新出现在里面。否则配 `http://IP:19798/dav` 时会去打 `/115open`（丢 /dav）。
     * 所以最终形态就是 `basePrefix + encPath(rel)`（rel 为 "/" 时 basePrefix 自己就是全部）。
     *
     * PROPFIND 打的**永远**是目录，所以统一按 server.js 传 `isDir=true` 的形态补尾斜杠 ——
     * 两边对拍才能全绿。唯一例外是「服务根自己」：`/dav` 不能写成 `/dav/`，
     * 因为 CD2 对 `/dav/` 回 301 且 Location 缺主机名，跟着跳就废。
     */
    String propfindPath(String path) {
        String rel = relOf(path);
        if ("/".equals(rel)) return basePrefix.isEmpty() ? "/" : basePrefix;
        if (rel.isEmpty()) return basePrefix + "/";
        String p = basePrefix + encPath(rel);
        return p.endsWith("/") ? p : p + "/";
    }

    /**
     * PUT 上传一个文件（strm 自动库用，2026-09-20）。
     *
     * ⚠️ 与 propfindPath 的关键区别：PUT 打的是**文件**，绝不能补尾斜杠 ——
     *    `PUT /xxx.mp4.strm/` 在多数 WebDAV 实现上要么 405、要么把资源建成目录，
     *    之后同名文件永远写不进去。文件就是文件形态，encPath 已经保证不带尾斜杠。
     *
     * 返回 HTTP 状态码（201/204 = 成功；409 = 父目录不存在，调用方先 MKCOL 再重试）。
     */
    public int put(String absPath, byte[] body) throws IOException {
        String rel = relOf(absPath);
        String p;
        if ("/".equals(rel)) {
            // 根不是文件：这里传错目标了，让服务器 405/403 顶回去（不该发生，防御性）
            p = basePrefix.isEmpty() ? "/" : basePrefix;
        } else {
            p = basePrefix + encPath(rel);
        }
        RawResp r = rawRequest("PUT", p,
                new String[]{"Content-Type", "text/plain; charset=utf-8"},
                body == null ? new byte[0] : body);
        return r.code;
    }

    /**
     * MKCOL 建目录（strm 自动库的父目录链用，2026-09-20）。
     *
     * 目录语义与 propfindPath 相同：basePrefix 补回 + 尾斜杠保留
     * （有些实现严格按 RFC 4918 只认 `MKCOL /dir/` 形态；CD2/群晖两种都吃）。
     * 已存在时多数实现回 405 —— 调用方应把 405 当「成功」忽略。
     */
    public int mkcol(String absPath) throws IOException {
        String rel = relOf(absPath);
        String p;
        if ("/".equals(rel)) {
            p = basePrefix.isEmpty() ? "/" : basePrefix;
        } else {
            p = basePrefix + encPath(rel);
            if (!p.endsWith("/")) p = p + "/";
        }
        RawResp r = rawRequest("MKCOL", p, null, null);
        return r.code;
    }

    // ---------------------------------------------------------------- 原始 HTTP（支持 PROPFIND 等自定义方法）

    /** HTTP 响应（rawRequest 用） */
    private static class RawResp {
        int code;
        String body = "";
    }

    /**
     * 用原生 Socket 手写 HTTP 请求 —— 唯一能在 Android 上发 PROPFIND 的可靠方式。
     * Connection: close + 读到 EOF，不用管 Content-Length / chunked，最简单也最稳。
     * https 走 SSL Socket 并信任所有证书（群晖等 NAS 自签证书是常态）。
     */
    private RawResp rawRequest(String method, String path, String[] headers, byte[] body) throws IOException {
        URL u = new URL(base);
        String host = u.getHost();
        final String hostHeader = host;                                    // Host 头保留原样（IPv6 要带方括号）
        if (host != null) host = host.replace("[", "").replace("]", "");   // Socket 连接要去掉方括号
        int port = u.getPort() > 0 ? u.getPort() : "https".equalsIgnoreCase(u.getProtocol()) ? 443 : 80;
        boolean tls = "https".equalsIgnoreCase(u.getProtocol());

        java.net.Socket sock = tls ? trustAllFactory().createSocket(host, port) : new java.net.Socket(host, port);
        sock.setSoTimeout(30000);
        try {
            OutputStream os = sock.getOutputStream();
            StringBuilder head = new StringBuilder();
            head.append(method).append(' ').append(path).append(" HTTP/1.1\r\n");
            head.append("Host: ").append(hostHeader).append(port > 0 && port != (tls ? 443 : 80) ? ":" + port : "").append("\r\n");
            head.append("User-Agent: douyin-nas-android\r\n");
            if (auth != null) head.append("Authorization: ").append(auth).append("\r\n");
            if (headers != null) {
                for (int i = 0; i + 1 < headers.length; i += 2) head.append(headers[i]).append(": ").append(headers[i + 1]).append("\r\n");
            }
            head.append("Connection: close\r\n");
            head.append("Content-Length: ").append(body == null ? 0 : body.length).append("\r\n");
            head.append("\r\n");
            os.write(head.toString().getBytes("UTF-8"));
            if (body != null && body.length > 0) os.write(body);
            os.flush();

            InputStream in = sock.getInputStream();
            // 读响应头（按字节扫到 \r\n\r\n，避免 readLine 吞掉 body 开头）
            ByteArrayOutputStream headBuf = new ByteArrayOutputStream();
            int state = 0;
            int status = 0;
            while ((status = in.read()) >= 0) {
                headBuf.write(status);
                if (status == '\n' && (state == 1 || state == 3)) state++;
                else if (status == '\r') state++;
                else state = 0;
                if (state >= 4) break;
            }
            String respHead = headBuf.toString("UTF-8");
            int code = 0;
            if (respHead.startsWith("HTTP/")) {
                int sp1 = respHead.indexOf(' ');
                if (sp1 > 0) code = Integer.parseInt(respHead.substring(sp1 + 1, sp1 + 4).trim());
            }
            // 读 body：HTTP/1.1 服务器（含群晖）即使 Connection: close 也可能用 chunked ——
            // 必须按 chunk 协议解码，否则 \r\n800\r\n 这类 chunk 大小行会混进 XML 把标签打断
            boolean chunked = respHead.toLowerCase().contains("transfer-encoding: chunked");
            ByteArrayOutputStream bodyBuf = new ByteArrayOutputStream();
            if (chunked) {
                while (true) {
                    String sizeLine = readCrLfLine(in);
                    if (sizeLine == null) break;
                    int size;
                    try { size = Integer.parseInt(sizeLine.trim().split(";")[0], 16); }
                    catch (Exception e) { break; }
                    if (size <= 0) {
                        // 0 块后是 trailer（若干行头 + 空行），读到空行为止
                        while (true) { String t = readCrLfLine(in); if (t == null || t.isEmpty()) break; }
                        break;
                    }
                    byte[] cb = new byte[size];
                    int off = 0;
                    while (off < size) {
                        int k = in.read(cb, off, size - off);
                        if (k < 0) break;
                        off += k;
                    }
                    bodyBuf.write(cb, 0, off);
                    in.read(); in.read();   // 块尾 CRLF
                }
            } else {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bodyBuf.write(buf, 0, n);
            }

            RawResp r = new RawResp();
            r.code = code;
            r.body = bodyBuf.toString("UTF-8");
            return r;
        } finally {
            try { sock.close(); } catch (IOException ignore) {}
        }
    }

    /** 从流里读一行（到 \n，忽略 \r），用于 chunk 大小行 / trailer。流结束返回 null */
    private static String readCrLfLine(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') bos.write(c);
        }
        if (c < 0 && bos.size() == 0) return null;
        return bos.toString("UTF-8");
    }

    /** 信任所有证书的 SSL Socket 工厂 —— NAS 自签证书是常态，握手失败比不安全更常见 */
    private static javax.net.ssl.SSLSocketFactory trustAllFactory() throws IOException {
        try {
            javax.net.ssl.TrustManager[] tm = new javax.net.ssl.TrustManager[]{
                new javax.net.ssl.X509TrustManager() {
                    public void checkClientTrusted(java.security.cert.X509Certificate[] chain, String authType) {}
                    public void checkServerTrusted(java.security.cert.X509Certificate[] chain, String authType) {}
                    public java.security.cert.X509Certificate[] getAcceptedIssuers() { return new java.security.cert.X509Certificate[0]; }
                }
            };
            javax.net.ssl.SSLContext sc = javax.net.ssl.SSLContext.getInstance("TLS");
            sc.init(null, tm, new java.security.SecureRandom());
            return sc.getSocketFactory();
        } catch (Exception e) {
            return (javax.net.ssl.SSLSocketFactory) javax.net.ssl.SSLSocketFactory.getDefault();
        }
    }

    /** 解析 PROPFIND 返回的 multistatus XML，抽目录项 */
    static List<Entry> parsePropfind(String xml) {
        List<Entry> out = new ArrayList<>();
        // 用正则按 <d:response> 分段解析，够用且不引入 XML 库
        String[] responses = xml.split("(?i)<d:response>|<response>");
        for (int i = 1; i < responses.length; i++) {
            String seg = responses[i].split("(?i)</d:response>|</response>")[0];
            Entry e = new Entry();
            e.href = tag(seg, "href");
            if (e.href == null) continue;
            // 相对路径：去掉 base 前缀的 host 部分，只留 path
            try {
                java.net.URI u = new java.net.URI(e.href);
                e.href = u.getPath();
            } catch (Exception ignore) {}
            if (e.href == null || e.href.isEmpty()) continue;
            try { e.href = java.net.URLDecoder.decode(e.href, "UTF-8"); } catch (Exception ignore) {}

            // 资源类型：有 <collection/> 就是目录
            String rt = tag(seg, "resourcetype");
            e.isDir = rt != null && rt.contains("collection");

            String len = tag(seg, "getcontentlength");
            e.size = len == null ? 0 : parseLong(len);

            String mt = tag(seg, "getlastmodified");
            e.mtime = parseHttpDate(mt);

            // 显示名：优先用 PROPFIND 的 displayname 字段，没有再从 href 尾段取
            String dn = tag(seg, "displayname");
            if (dn != null && !dn.isEmpty()) {
                e.name = dn;
            } else {
                String n = e.href;
                while (n.endsWith("/")) n = n.substring(0, n.length() - 1);
                int slash = n.lastIndexOf('/');
                e.name = slash >= 0 ? n.substring(slash + 1) : n;
                if (e.name.isEmpty()) e.name = "/";
            }
            try { e.name = java.net.URLDecoder.decode(e.name, "UTF-8"); } catch (Exception ignore) {}
            out.add(e);
        }
        return out;
    }

    private static String tag(String seg, String name) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("(?i)<(?:d:)?" + name + "[^>]*>(.*?)</(?:d:)?" + name + ">", java.util.regex.Pattern.DOTALL)
                .matcher(seg);
        if (m.find()) return m.group(1).trim();
        // 空标签形式 <d:getcontentlength/>
        m = java.util.regex.Pattern.compile("(?i)<(?:d:)?" + name + "[^>]*/>").matcher(seg);
        if (m.find()) return "";
        return null;
    }

    private static long parseLong(String s) {
        try { return Long.parseLong(s); } catch (Exception e) { return 0; }
    }

    /** 解析 HTTP 日期（RFC1123，如 "Mon, 15 Aug 2026 12:00:00 GMT"）为毫秒 */
    private static long parseHttpDate(String s) {
        if (s == null) return 0;
        try {
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", java.util.Locale.US);
            f.setTimeZone(java.util.TimeZone.getTimeZone("GMT"));
            return f.parse(s).getTime();
        } catch (Exception e) { return 0; }
    }

    private HttpURLConnection open(String url) throws IOException {
        URL u = new URL(url);
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "douyin-nas-android");
        if (auth != null) c.setRequestProperty("Authorization", auth);
        return c;
    }

    private static String readAll(InputStream is) throws IOException {
        if (is == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        return bos.toString("UTF-8");
    }
}
