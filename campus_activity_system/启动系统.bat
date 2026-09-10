@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_EXE=C:\Users\Echo\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"

if not exist "%PYTHON_EXE%" (
  echo 未检测到可用的 Python 运行时。
  echo 请先安装 Python，并将 python 添加到系统 PATH 后重新打开此文件。
  pause
  exit /b 1
)

start "校园活动管理系统服务" /D "%~dp0" "%PYTHON_EXE%" app.py
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:5000

echo 系统已启动。请保持“校园活动管理系统服务”窗口打开；在该窗口按 Ctrl+C 可停止服务。
pause
