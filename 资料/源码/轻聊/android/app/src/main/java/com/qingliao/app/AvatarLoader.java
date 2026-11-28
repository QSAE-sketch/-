package com.qingliao.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Handler;
import android.os.Looper;
import android.util.LruCache;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 用户真实头像加载器（原生，不依赖任何图片库）。
 *
 * 设计要点：
 *  1. 两级缓存：内存 LruCache（按带 ?v= 的完整路径，换头像后 URL 变、缓存自然失效）。
 *  2. 单线程池串行下载，避免滚动时并发几十个请求把带宽和内存打爆。
 *  3. 失败记进 failed 集合，同一次进程内不再反复重试（否则滚动会一直重发请求）。
 *  4. 回调统一 post 到主线程，调用方可以直接 setImageBitmap。
 *
 * 走系统 CookieHandler（Api 里已设置），网关会话 Cookie 会自动带上。
 */
public class AvatarLoader {

    public interface Callback {
        void onLoaded(String path, Bitmap bmp);
    }

    private final LruCache<String, Bitmap> cache;
    private final Set<String> failed = Collections.synchronizedSet(new HashSet<String>());
    private final Set<String> loading = Collections.synchronizedSet(new HashSet<String>());
    private final ExecutorService pool = Executors.newFixedThreadPool(1);
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Api api;
    private final int targetPx;
    private final boolean crop;
    private final int maxBytes;

    public AvatarLoader(Api api, int targetPx) {
        this(api, targetPx, true);
    }

    /**
     * @param crop true=裁圆（头像）；false=原样缩放（聊天里的图片）
     */
    public AvatarLoader(Api api, int targetPx, boolean crop) {
        this.api = api;
        this.crop = crop;
        this.maxBytes = crop ? 2 * 1024 * 1024 : 8 * 1024 * 1024;
        this.targetPx = targetPx < 24 ? 96 : targetPx;
        // 内存缓存上限按像素估算：约 4MB，够放几百张小头像
        int kb = (int) (Runtime.getRuntime().maxMemory() / 1024);
        final int cacheSize = Math.min(kb / 8, 4096);
        cache = new LruCache<String, Bitmap>(cacheSize) {
            @Override
            protected int sizeOf(String key, Bitmap value) {
                return value.getByteCount() / 1024;
            }
        };
    }

    /** 同步取缓存；没有返回 null（调用方可立即用它决定先画占位还是直接画图） */
    public Bitmap peek(String path) {
        if (path == null || path.length() == 0) return null;
        return cache.get(path);
    }

    /**
     * 异步加载。命中缓存时同步回调（仍在主线程语义下）。
     * 失败过或正在加载的 path 直接返回，不重复发请求。
     */
    public void load(final String path, final Callback cb) {
        if (path == null || path.length() == 0) return;

        Bitmap hit = cache.get(path);
        if (hit != null) {
            if (cb != null) cb.onLoaded(path, hit);
            return;
        }
        if (failed.contains(path) || !loading.add(path)) return;

        pool.execute(new Runnable() {
            public void run() {
                final Bitmap bmp = downloadAndDecode(path);
                loading.remove(path);
                if (bmp == null) {
                    failed.add(path);
                    return;
                }
                cache.put(path, bmp);
                ui.post(new Runnable() {
                    public void run() {
                        if (cb != null) cb.onLoaded(path, bmp);
                    }
                });
            }
        });
    }

    /** 换账号 / 换服务器时清空，避免旧头像串到新会话 */
    public void clear() {
        cache.evictAll();
        failed.clear();
        loading.clear();
    }

    private Bitmap downloadAndDecode(String path) {
        HttpURLConnection c = null;
        try {
            URL url = new URL(api.base() + path);
            c = (HttpURLConnection) url.openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(15000);
            c.setInstanceFollowRedirects(true);
            if (api.token().length() > 0) c.setRequestProperty("x-token", api.token());
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) return null;

            InputStream is = c.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n, total = 0;
            while ((n = is.read(buf)) > 0) {
                total += n;
                if (total > maxBytes) { is.close(); return null; }
                bos.write(buf, 0, n);
            }
            is.close();
            byte[] data = bos.toByteArray();
            if (data.length == 0) return null;

            // 先读尺寸再按需降采样，避免把 512KB 大图整张解码进内存
            BitmapFactory.Options opt = new BitmapFactory.Options();
            opt.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(data, 0, data.length, opt);
            int scale = 1;
            int longer = Math.max(opt.outWidth, opt.outHeight);
            while (longer / scale > targetPx * 2) scale *= 2;

            BitmapFactory.Options opt2 = new BitmapFactory.Options();
            opt2.inSampleSize = scale;
            opt2.inPreferredConfig = Bitmap.Config.ARGB_8888;
            Bitmap raw = BitmapFactory.decodeByteArray(data, 0, data.length, opt2);
            return raw == null ? null : (crop ? circleCrop(raw) : raw);
        } catch (Throwable t) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 裁成圆形（网页端头像是圆的，这边保持一致的观感），顺带居中缩放 */
    private static Bitmap circleCrop(Bitmap src) {
        try {
            int size = Math.min(src.getWidth(), src.getHeight());
            if (size <= 0) return src;
            Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(out);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            float r = size / 2f;
            canvas.drawCircle(r, r, r, paint);                       // 先画圆形遮罩
            paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
            RectF dst = new RectF(0, 0, size, size);
            canvas.drawBitmap(src, new Rect(0, 0, src.getWidth(), src.getHeight()), dst, paint);
            if (src != out) src.recycle();
            return out;
        } catch (Throwable t) {
            return src;
        }
    }
}
