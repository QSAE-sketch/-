@echo off
REM QingLiao native Windows client build script.
REM Requires MinGW-w64 (g++ / windres in PATH).
REM Output: qingliao.exe (native Win32 + GDI, no WebView, no Electron)
REM NOTE: keep this file ASCII-only; cmd.exe decodes .bat with the local ANSI code page.
setlocal
cd /d "%~dp0"

where g++ >nul 2>&1
if errorlevel 1 (
  echo [ERROR] g++ not found. Install MinGW-w64 and add it to PATH.
  exit /b 1
)

echo [1/3] Compiling resources...
windres -i resources.rc -o resources.o -O coff
if errorlevel 1 goto :fail

echo [2/3] Compiling native client...
g++ -O2 -s -municode -mwindows -std=c++11 -o qingliao.exe ^
  src/main.cpp src/api.cpp src/http.cpp src/image.cpp resources.o ^
  -lwinhttp -lcomdlg32 -lcomctl32 -lshlwapi -lshell32 -lole32 -lcrypt32 ^
  -lgdiplus -lgdi32 -luser32 -static
if errorlevel 1 goto :fail

echo [3/3] Settings a Unicode file name...
python rename_exe.py
if errorlevel 1 goto :fail

del /q resources.o >nul 2>&1
echo.
echo Done. Output: the Chinese-named EXE in this folder.
exit /b 0

:fail
echo [ERROR] Build failed.
exit /b 1
