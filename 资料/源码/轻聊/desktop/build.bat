@echo off
REM QingLiao Windows desktop launcher build script.
REM Requires MinGW-w64 (g++ / windres / python in PATH).
REM Output: a Chinese-named EXE without any version suffix.
REM NOTE: keep this file ASCII-only. cmd.exe decodes .bat as the local ANSI
REM code page, so Chinese text here would be mangled on Chinese Windows.
setlocal
cd /d "%~dp0"

where g++ >nul 2>&1
if errorlevel 1 (
  echo [ERROR] g++ not found. Install MinGW-w64 and add it to PATH.
  exit /b 1
)

echo [1/4] Compiling icon resource...
windres -i resources.rc -o resources.o -O coff
if errorlevel 1 goto :fail

echo [2/4] Compiling launcher...
g++ -Os -s -municode -mwindows -std=c++11 -o qingliao_tmp.exe main.cpp resources.o -lshlwapi -lshell32 -lole32
if errorlevel 1 goto :fail

echo [3/4] Setting Unicode filename...
python rename_exe.py
if errorlevel 1 goto :fail

echo [4/4] Cleaning up...
del /q resources.o qingliao_tmp.exe >nul 2>&1

echo.
echo Done. Output: the Chinese-named EXE in this folder.
exit /b 0

:fail
echo [ERROR] Build failed.
exit /b 1
