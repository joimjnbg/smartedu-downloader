@echo off
echo === SmartEdu下载器 - 跨平台构建脚本 ===
echo.
echo 可用命令:
echo   build:win-x64     - Windows x64 (.exe)
echo   build:win-arm64   - Windows ARM64 (.exe)
echo   build:mac-x64     - macOS x64 (.zip)
echo   build:mac-arm64   - macOS ARM64 (.zip)
echo   build:linux-x64   - Linux x64 (.AppImage)
echo   build:linux-arm64 - Linux ARM64 (.AppImage)
echo   build:all         - 所有平台
echo.
echo 用法: npm run ^<command^>
echo.
echo 示例: npm run build:win-x64
echo.
pause
