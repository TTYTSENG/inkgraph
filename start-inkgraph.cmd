@echo off
setlocal
cd /d "%~dp0"
set "INKGRAPH_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    set "INKGRAPH_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  ) else (
    echo Please install Node.js 24 or later from https://nodejs.org/
    pause
    exit /b 1
  )
)
"%INKGRAPH_NODE%" -e "if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Node.js 24 or later is required.'); process.exit(1); }"
if errorlevel 1 (
  pause
  exit /b 1
)
if not exist "node_modules\citeproc\package.json" (
  where npm >nul 2>nul
  if not errorlevel 1 (
    call npm install
  ) else (
    if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd" (
      call "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd" install
    ) else (
      echo npm was not found. Install Node.js 24 and run npm install.
      pause
      exit /b 1
    )
  )
  if errorlevel 1 (
    echo Dependency installation failed. Check your internet connection.
    pause
    exit /b 1
  )
)
echo InkGraph: http://127.0.0.1:4317
echo Open this address in Chrome. Keep this window open; press Ctrl+C to stop.
"%INKGRAPH_NODE%" server.mjs
pause
