@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动龙娘跑团启动器（这个窗口可以留着看日志，关掉窗口等于关掉启动器）……
node server.mjs
if errorlevel 1 pause
