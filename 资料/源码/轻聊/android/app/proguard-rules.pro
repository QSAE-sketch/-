# 默认规则即可（release 未开启混淆）。
# 保留 WebView 相关回调，防止未来开启 R8 时行为变化。
-keepclassmembers class com.qingliao.app.** {
    public boolean openFileChooser(android.webkit.WebView, android.webkit.ValueCallback, java.lang.String, java.lang.String[]);
}
