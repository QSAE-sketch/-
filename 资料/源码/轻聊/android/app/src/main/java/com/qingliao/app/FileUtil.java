package com.qingliao.app;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

/** 选文件后的落盘工具：拿显示名、把 content:// 复制成本地临时文件。 */
public class FileUtil {

    public static String displayName(Context c, Uri uri) {
        String name = null;
        try {
            ContentResolver cr = c.getContentResolver();
            Cursor cur = cr.query(uri, null, null, null, null);
            if (cur != null) {
                int idx = cur.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0 && cur.moveToFirst()) name = cur.getString(idx);
                cur.close();
            }
        } catch (Exception ignored) {
        }
        if (name == null || name.length() == 0) {
            name = uri.getLastPathSegment();
            if (name == null) name = "file";
            int slash = name.lastIndexOf('/');
            if (slash >= 0) name = name.substring(slash + 1);
        }
        return name;
    }

    /** 复制到应用缓存目录，返回本地文件（上传完可以删） */
    public static File copyToCache(Context c, Uri uri, String name) throws Exception {
        File dir = new File(c.getCacheDir(), "upload");
        if (!dir.exists()) dir.mkdirs();
        File out = new File(dir, System.currentTimeMillis() + "_" + safe(name));
        InputStream is = c.getContentResolver().openInputStream(uri);
        if (is == null) throw new Exception("无法读取所选文件");
        FileOutputStream fos = new FileOutputStream(out);
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = is.read(buf)) > 0) fos.write(buf, 0, n);
        fos.flush();
        fos.close();
        is.close();
        return out;
    }

    public static String safe(String name) {
        String s = name == null ? "file" : name;
        s = s.replace('\\', '_').replace('/', '_').replace(':', '_')
                .replace('*', '_').replace('?', '_').replace('"', '_')
                .replace('<', '_').replace('>', '_').replace('|', '_');
        if (s.length() > 80) s = s.substring(s.length() - 80);
        return s;
    }
}
