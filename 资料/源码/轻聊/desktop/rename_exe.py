"""把 ASCII 中间产物重命名为中文文件名（无版本号后缀）。

.bat 在中文 Windows 下按本地 ANSI 代码页解析，中文会被弄乱；
Windows 文件名本身是 Unicode，用 Python 的 Unicode API 写才可靠。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'qingliao_tmp.exe')
DST = os.path.join(HERE, '\u8f7b\u804a.exe')  # 轻聊.exe

if not os.path.isfile(SRC):
    sys.stderr.write('missing intermediate: %s\n' % SRC)
    sys.exit(1)

# 清掉所有旧的 exe 产物（含历史误编码文件名），只留一个规范名
for name in os.listdir(HERE):
    if name.lower().endswith('.exe') and name != 'qingliao_tmp.exe':
        try:
            os.remove(os.path.join(HERE, name))
        except OSError:
            pass

os.rename(SRC, DST)
print('output: %s (%d bytes)' % (os.path.basename(DST), os.path.getsize(DST)))
