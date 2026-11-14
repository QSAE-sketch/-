/*
 * 轻聊原生客户端 · 图片处理（GDI+）
 *
 * 两个用途：
 *   1. 更换头像：把任意本地图缩放成 256×256 JPEG 再上传（服务端限 512KB）
 *   2. 显示头像：把服务端返回的头像字节解码成 GDI+ 图像，圆形裁剪绘制
 *
 * 全部走 GDI+（系统自带 gdiplus.dll），不引第三方库。
 */
#ifndef QL_IMAGE_H
#define QL_IMAGE_H

#include <windows.h>
#include <string>
#include <vector>

namespace ql {

/** GDI+ 启动 / 关闭（幂等，wWinMain 调一次） */
void imageInit();
void imageShutdown();

/** 把本地图缩放成 256×256 JPEG（居中裁方）；失败返回空 */
std::vector<unsigned char> scaleToAvatarJpeg(const std::wstring& path);

/** 内存图片字节 → GDI+ 图像（png/jpeg/gif/bmp）；失败返回 NULL */
void* decodeImage(const void* data, size_t len);

/** 释放 decodeImage 的产物 */
void freeImage(void* img);

/** 在 dc 上把 img 圆形裁剪绘制到 r（保持比例，居中裁方） */
void drawImageCircle(HDC dc, void* img, const RECT& r);

/**
 * 金色烫金圆角矩形（founder 消息气泡）：
 * 斜向金箔渐变打底 + 随 phase 缓慢移动的高光带（流光效果）。
 * phase 一般传 GetTickCount()/40。
 */
void fillGoldRoundRect(HDC dc, const RECT& r, int radius, unsigned phase);

/** 头像外圈的金色双环 + 光晕 */
void drawGoldRing(HDC dc, const RECT& r);

/** base64 编码（头像上传用） */
std::string base64Encode(const void* data, size_t len);

}  // namespace ql

#endif  // QL_IMAGE_H
