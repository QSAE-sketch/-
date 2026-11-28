package com.qingliao.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.widget.Toast;

/**
 * 下载：交给系统下载器（通知栏可见、可断点），不需要自己写续传。
 *
 * 线上站点在分享网关后面，必须把网关 Cookie 和登录 token 一起塞进请求头，
 * 否则下载会被 403。Cookie 从 Api 的 CookieManager 里取。
 */
public class Downloads {

    public static final int REQ_PERM = 9101;
    private static Runnable pending;

    public static void save(final Activity a, final Api api, final Prefs prefs,
                            final String urlPath, final String name) {
        final boolean pub = prefs.downloadPublic();
        if (pub && Build.VERSION.SDK_INT >= 23 && Build.VERSION.SDK_INT < 29) {
            if (a.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                pending = new Runnable() {
                    public void run() { save(a, api, prefs, urlPath, name); }
                };
                a.requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_PERM);
                return;
            }
        }
        try {
            DownloadManager dm = (DownloadManager) a.getSystemService(Context.DOWNLOAD_SERVICE);
            Uri uri = Uri.parse(api.base() + urlPath);
            DownloadManager.Request r = new DownloadManager.Request(uri);
            r.setTitle(name);
            r.setDescription("轻聊 · 下载");
            r.addRequestHeader("x-token", api.token());
            String ck = api.cookieHeader();
            if (ck.length() > 0) r.addRequestHeader("Cookie", ck);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            String safe = FileUtil.safe(name);
            if (pub) {
                r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "轻聊/" + safe);
            } else {
                r.setDestinationInExternalFilesDir(a, Environment.DIRECTORY_DOWNLOADS, safe);
            }
            dm.enqueue(r);
            Toast.makeText(a, pub ? "已开始下载，完成后在「下载」目录" : "已开始下载到应用私有目录",
                    Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(a, "下载失败：" + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    /** 在 Activity.onRequestPermissionsResult 里调一下，权限通过就继续下载 */
    public static boolean onPermissionResult(int req, int[] grant) {
        if (req != REQ_PERM) return false;
        if (pending != null) {
            Runnable r = pending;
            pending = null;
            if (grant.length > 0 && grant[0] == PackageManager.PERMISSION_GRANTED) r.run();
        }
        return true;
    }
}
