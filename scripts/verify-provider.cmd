@echo off
chcp 65001 >nul
title DCODE 多 Provider + 代理 验证
cd /d "%~dp0.."
echo.
echo ============================================================
echo   DCODE 多 Provider / 代理 验证
echo   目录: %CD%
echo   时间: %DATE% %TIME%
echo ============================================================
echo.

echo [1/5] TypeScript 类型检查...
call npm run typecheck
if errorlevel 1 goto :fail
echo [OK] typecheck 通过
echo.

echo [2/5] 全量单元测试...
call npm test
if errorlevel 1 goto :fail
echo [OK] 单元测试通过
echo.

echo [3/5] Provider/Proxy 专项测试...
call npx vitest run src/providers/proxy.test.ts src/providers/registry.test.ts src/commands/suggestions.test.ts
if errorlevel 1 goto :fail
echo [OK] Provider 专项测试通过
echo.

echo [4/5] 构建 dist/cli.js...
call npm run build
if errorlevel 1 goto :fail
echo [OK] build 通过
echo.

echo [5/5] OpenAI Live 集成测试（需 OPENAI_API_KEY + 代理）...
if not defined OPENAI_API_KEY (
  echo [SKIP] 未设置 OPENAI_API_KEY，跳过 Live 测试
  echo        在本窗口执行后可重跑第 5 步:
  echo          set OPENAI_API_KEY=sk-你的Key
  echo          set DCODE_PROXY=http://127.0.0.1:10793
  echo          npx vitest run src/providers/live.integration.test.ts
  goto :done
)
if not defined DCODE_PROXY (
  if not defined HTTPS_PROXY (
    echo [INFO] 未设置 DCODE_PROXY/HTTPS_PROXY，使用默认 http://127.0.0.1:10793
    set DCODE_PROXY=http://127.0.0.1:10793
  )
)
call npx vitest run src/providers/live.integration.test.ts
if errorlevel 1 goto :fail
echo [OK] OpenAI Live 测试通过
echo.

:done
echo ============================================================
echo   验证完成
echo ============================================================
echo.
pause
exit /b 0

:fail
echo.
echo ============================================================
echo   验证失败 - 请查看上方错误
echo ============================================================
echo.
pause
exit /b 1
