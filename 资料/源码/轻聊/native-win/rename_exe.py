"""把 qingliao.exe 重命名为「轻聊.exe」。

.bat 在中文 Windows 下按本地 ANSI 代码页解析，中文会乱；Windows 文件名本身是
Unicode，用 Python 的 Unicode API 写才可靠。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'qingliao.exe')
DST = os.path.join(HERE, '\u8f7b\u804a.exe')  # 轻聊.exe

if not os.path.isfile(SRC):
    sys.stderr.write('missing intermediate: %s\n' % SRC)
    sys.exit(1)

# 清掉旧的 exe 产物，只留一个规范名
for name in os.listdir(HERE):
    if name.lower().endswith('.exe') and name.lower() != 'qingliao.exe':
        try:
            os.remove(os.path.join(HERE, name))
        except OSError:
            pass

if os.path.exists(DST):
    os.remove(DST)
os.rename(SRC, DST)
print('output: %s (%d bytes)' % (os.path.basename(DST), os.path.getsize(DST)))
