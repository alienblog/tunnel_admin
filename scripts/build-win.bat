@echo off
rem TunnelAdmin Windows 桌面版一键打包（双击运行）
rem 建议右键「以管理员身份运行」——解决符号链接解压权限（winCodeSign）
powershell -ExecutionPolicy Bypass -File "%~dp0build-win.ps1" %*
if %errorlevel% neq 0 (
  echo.
  echo 构建失败，请查看上方错误信息。常见原因：
  echo   - 符号链接权限：请以管理员身份运行，或开启 Windows 开发者模式
  echo   - 网络问题：加 -Proxy http://127.0.0.1:7897 参数重试
)
pause
