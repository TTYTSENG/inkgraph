param([int]$Port=4318)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$labRoot=Split-Path -Parent $repoRoot
$modelRoot=Join-Path $labRoot 'models'
$modelAlias=Join-Path $env:TEMP 'inkgraph-media-models-20261025'
if (-not (Test-Path -LiteralPath $modelAlias)) { New-Item -ItemType Junction -Path $modelAlias -Target $modelRoot | Out-Null }
if ((Get-Item -LiteralPath $modelAlias).Target -ne $modelRoot) { throw '模型路徑別名已被其他目錄使用，停止啟動' }
$env:INKGRAPH_MEDIA_PYTHON=Join-Path $labRoot 'tools/media-env/Scripts/python.exe'
$env:INKGRAPH_MEDIA_MODELS=$modelAlias
$env:INKGRAPH_ADB=Join-Path $env:LOCALAPPDATA 'Android/Sdk/platform-tools/adb.exe'
$env:INKGRAPH_DATA_DIR=Join-Path $labRoot 'vault'
$env:INKGRAPH_DISPOSABLE='1'
$env:PORT=[string]$Port
if (-not (Test-Path -LiteralPath $env:INKGRAPH_MEDIA_PYTHON)) { throw '尚未建立本地辨識環境' }
$nodeCommand=Get-Command node -ErrorAction Stop
New-Item -ItemType Directory -Force -Path (Join-Path $repoRoot 'artifacts') | Out-Null
Start-Process -FilePath $nodeCommand.Source -ArgumentList (Join-Path $repoRoot 'server.mjs') -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $repoRoot 'artifacts/mobile-service.stdout.log') -RedirectStandardError (Join-Path $repoRoot 'artifacts/mobile-service.stderr.log')
Write-Output "手機測試工作區：http://127.0.0.1:$Port/#mobile"
