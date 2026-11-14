#include "image.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objidl.h>
#include <gdiplus.h>
#include <cstdio>
#include <cstring>

#pragma comment(lib, "gdiplus.lib")

using namespace Gdiplus;

namespace ql {

static ULONG_PTR g_gdipToken = 0;
static int g_gdipRefs = 0;

void imageInit() {
    if (g_gdipRefs++ > 0) return;
    GdiplusStartupInput in;
    GdiplusStartup(&g_gdipToken, &in, NULL);
}

void imageShutdown() {
    if (--g_gdipRefs > 0) return;
    if (g_gdipToken) {
        GdiplusShutdown(g_gdipToken);
        g_gdipToken = 0;
    }
}

/* ---------------- 内存流：字节 → IStream ---------------- */

static IStream* streamFromBytes(const void* data, size_t len) {
    HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, len);
    if (!h) return NULL;
    void* p = GlobalLock(h);
    if (!p) { GlobalFree(h); return NULL; }
    memcpy(p, data, len);
    GlobalUnlock(h);
    IStream* st = NULL;
    if (FAILED(CreateStreamOnHGlobal(h, TRUE, &st))) {  // TRUE = 流释放时一起释放 h
        GlobalFree(h);
        return NULL;
    }
    return st;
}

/* ---------------- 解码 ---------------- */

void* decodeImage(const void* data, size_t len) {
    if (!data || !len) return NULL;
    imageInit();
    IStream* st = streamFromBytes(data, len);
    if (!st) return NULL;
    Bitmap* bmp = new Bitmap(st);
    st->Release();
    if (!bmp || bmp->GetLastStatus() != Ok) {
        delete bmp;
        return NULL;
    }
    return bmp;
}

void freeImage(void* img) {
    delete static_cast<Bitmap*>(img);
}

/* ---------------- 圆形绘制 ---------------- */

void drawImageCircle(HDC dc, void* img, const RECT& r) {
    Bitmap* bmp = static_cast<Bitmap*>(img);
    if (!bmp || !dc) return;
    int W = r.right - r.left;
    int H = r.bottom - r.top;
    if (W <= 0 || H <= 0) return;

    Graphics g(dc);
    g.SetSmoothingMode(SmoothingModeAntiAlias);
    g.SetInterpolationMode(InterpolationModeHighQualityBicubic);

    GraphicsPath path;
    path.AddEllipse(0, 0, W - 1, H - 1);
    g.SetClip(&path);

    // 居中裁方
    int iw = (int)bmp->GetWidth();
    int ih = (int)bmp->GetHeight();
    int side = iw < ih ? iw : ih;
    int sx = (iw - side) / 2;
    int sy = (ih - side) / 2;
    g.DrawImage(bmp, Rect(r.left, r.top, W, H), sx, sy, side, side, UnitPixel);

    // 一圈细边，避免浅色头像贴在浅色背景上糊掉
    Pen pen(Color(70, 0, 0, 0), 1.0f);
    g.DrawEllipse(&pen, r.left, r.top, W - 1, H - 1);
}

/* ---------------- 头像缩放 → JPEG ---------------- */

static int getJpegClsid(CLSID* clsid) {
    UINT n = 0, size = 0;
    GetImageEncodersSize(&n, &size);
    if (!size) return -1;
    std::vector<char> buf(size);
    ImageCodecInfo* info = (ImageCodecInfo*)&buf[0];
    GetImageEncoders(n, size, info);
    for (UINT i = 0; i < n; i++) {
        if (wcscmp(info[i].MimeType, L"image/jpeg") == 0) {
            *clsid = info[i].Clsid;
            return 0;
        }
    }
    return -1;
}

std::vector<unsigned char> scaleToAvatarJpeg(const std::wstring& path) {
    std::vector<unsigned char> out;
    imageInit();

    Bitmap src(path.c_str());
    if (src.GetLastStatus() != Ok) return out;

    const int D = 256;
    Bitmap dst(D, D, PixelFormat24bppRGB);
    if (dst.GetLastStatus() != Ok) return out;

    {
        Graphics g(&dst);
        g.SetInterpolationMode(InterpolationModeHighQualityBicubic);
        g.SetSmoothingMode(SmoothingModeAntiAlias);
        g.Clear(Color(255, 255, 255, 255));
        int iw = (int)src.GetWidth();
        int ih = (int)src.GetHeight();
        int side = iw < ih ? iw : ih;
        int sx = (iw - side) / 2;
        int sy = (ih - side) / 2;
        g.DrawImage(&src, Rect(0, 0, D, D), sx, sy, side, side, UnitPixel);
    }

    CLSID jpegClsid;
    if (getJpegClsid(&jpegClsid) != 0) return out;

    // 先存到内存流再读回，避免临时文件
    IStream* st = NULL;
    if (FAILED(CreateStreamOnHGlobal(NULL, TRUE, &st))) return out;
    EncoderParameters params;
    params.Count = 1;
    params.Parameter[0].Guid = EncoderQuality;
    params.Parameter[0].Type = EncoderParameterValueTypeLong;
    params.Parameter[0].NumberOfValues = 1;
    ULONG quality = 86;
    params.Parameter[0].Value = &quality;

    Status st2 = dst.Save(st, &jpegClsid, &params);
    if (st2 != Ok) {
        st->Release();
        return out;
    }

    STATSTG stat;
    if (FAILED(st->Stat(&stat, STATFLAG_NONAME)) || stat.cbSize.QuadPart <= 0) {
        st->Release();
        return out;
    }
    size_t n = (size_t)stat.cbSize.QuadPart;
    out.resize(n);
    LARGE_INTEGER zero;
    zero.QuadPart = 0;
    st->Seek(zero, STREAM_SEEK_SET, NULL);
    ULONG got = 0;
    st->Read(&out[0], (ULONG)n, &got);
    out.resize(got);
    st->Release();
    return out;
}

/* ---------------- 金色烫金 ---------------- */

static void roundRectPath(GraphicsPath& path, const RECT& r, int radius) {
    int x = r.left, y = r.top, w = r.right - r.left, h = r.bottom - r.top;
    int d = radius * 2;
    if (d > w) d = w;
    if (d > h) d = h;
    int rr = d / 2;
    path.AddArc(x, y, d, d, 180, 90);
    path.AddArc(x + w - d, y, d, d, 270, 90);
    path.AddArc(x + w - d, y + h - d, d, d, 0, 90);
    path.AddArc(x, y + h - d, d, d, 90, 90);
    path.CloseFigure();
}

void fillGoldRoundRect(HDC dc, const RECT& r, int radius, unsigned phase) {
    imageInit();
    Graphics g(dc);
    g.SetSmoothingMode(SmoothingModeAntiAlias);
    g.SetPixelOffsetMode(PixelOffsetModeHalf);

    GraphicsPath path;
    roundRectPath(path, r, radius);

    // 金箔斜向渐变（深金 → 亮金 → 暖白 → 金）
    LinearGradientBrush br(Point(r.left - 40, r.top), Point(r.right + 40, r.bottom),
                           Color(255, 214, 160, 40), Color(255, 252, 232, 170));
    Color stops[4] = {Color(255, 214, 160, 40), Color(255, 245, 220, 130),
                      Color(255, 255, 250, 224), Color(255, 230, 185, 82)};
    REAL pos[4] = {0.0f, 0.32f, 0.55f, 1.0f};
    br.SetInterpolationColors(stops, pos, 4);
    g.FillPath(&br, &path);

    // 流光：一条半透明高光带随 phase 缓慢扫过
    REAL w = (REAL)(r.right - r.left);
    REAL band = w * 0.42f;
    REAL t = (REAL)((phase % 240) / 240.0);            // 0..1 循环
    REAL cx = -band + t * (w + band * 2);              // 从左外扫到右外
    PointF p1((REAL)r.left + cx - band, (REAL)r.bottom);
    PointF p2((REAL)r.left + cx + band, (REAL)r.top);
    LinearGradientBrush shine(p1, p2, Color(0, 255, 255, 255), Color(0, 255, 255, 255));
    Color sst[3] = {Color(0, 255, 255, 255), Color(120, 255, 252, 226), Color(0, 255, 255, 255)};
    REAL spos[3] = {0.0f, 0.5f, 1.0f};
    shine.SetInterpolationColors(sst, spos, 3);
    g.FillPath(&shine, &path);

    // 描边
    Pen pen(Color(255, 186, 138, 36), 1.2f);
    g.DrawPath(&pen, &path);
}

void drawGoldRing(HDC dc, const RECT& r) {
    imageInit();
    Graphics g(dc);
    g.SetSmoothingMode(SmoothingModeAntiAlias);
    int x = r.left, y = r.top, w = r.right - r.left, h = r.bottom - r.top;
    // 光晕（最外层淡金）
    Pen glow(Color(64, 212, 175, 55), 4.0f);
    g.DrawEllipse(&glow, x - 3, y - 3, w + 6, h + 6);
    // 主金环
    Pen ring(Color(255, 212, 175, 55), 2.0f);
    g.DrawEllipse(&ring, x - 1, y - 1, w + 2, h + 2);
    // 内侧细亮环
    Pen inner(Color(120, 255, 236, 170), 1.0f);
    g.DrawEllipse(&inner, x + 1, y + 1, w - 2, h - 2);
}

/* ---------------- base64 ---------------- */

static const char kTab[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64Encode(const void* data, size_t len) {
    const unsigned char* p = (const unsigned char*)data;
    std::string out;
    out.reserve((len + 2) / 3 * 4);
    for (size_t i = 0; i < len; i += 3) {
        unsigned int v = (unsigned int)p[i] << 16;
        if (i + 1 < len) v |= (unsigned int)p[i + 1] << 8;
        if (i + 2 < len) v |= (unsigned int)p[i + 2];
        out += kTab[(v >> 18) & 63];
        out += kTab[(v >> 12) & 63];
        out += (i + 1 < len) ? kTab[(v >> 6) & 63] : '=';
        out += (i + 2 < len) ? kTab[v & 63] : '=';
    }
    return out;
}

}  // namespace ql
