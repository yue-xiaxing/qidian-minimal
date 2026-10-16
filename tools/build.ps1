# 起点极简 · 打包脚本（PowerShell 7）
# 用法：pwsh -File tools\build.ps1
# 产物：dist\qidian-minimal-v<version>.zip

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
# ---------- 打包前硬门槛：所有 JS 必须通过语法检查 ----------
# 事故：曾把带语法错误的 popup.js 打进包里，用户装上后 Edge 报「错误」。
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  $cand = Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cand) { $nodeExe = $cand.FullName }
}
if ($nodeExe) {
  $jsFiles = Get-ChildItem (Join-Path $root 'src\*.js'), (Join-Path $root 'popup\*.js') -ErrorAction SilentlyContinue
  foreach ($f in $jsFiles) {
    & $nodeExe --check $f.FullName 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ("JS 语法检查未通过，已中止打包：" + $f.Name) }
  }
  Write-Host ("语法检查通过：" + $jsFiles.Count + " 个 JS 文件") -ForegroundColor Green
} else {
  Write-Host '未找到 node，跳过语法检查（请人工确认）' -ForegroundColor Yellow
}
Set-Location $root

$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
$name = 'qidian-minimal'

$dist = Join-Path $root 'dist'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $dist | Out-Null

$stage = Join-Path $dist $name
New-Item -ItemType Directory -Path $stage | Out-Null

# 只打包运行期需要的文件
$items = @('manifest.json', 'src', 'popup', 'icons')
foreach ($item in $items) {
    $src = Join-Path $root $item
    if (-not (Test-Path $src)) { throw "缺少必需文件/目录：$item" }
    Copy-Item $src -Destination $stage -Recurse -Force
}

# 附带文档（README 里引用的预览大图不打包，避免把安装包撑大）
foreach ($doc in @('README.md', 'LICENSE')) {
    $p = Join-Path $root $doc
    if (Test-Path $p) { Copy-Item $p -Destination $stage -Force }
}
$docDir = Join-Path $root 'docs'
if (Test-Path $docDir) {
    $docStage = Join-Path $stage 'docs'
    New-Item -ItemType Directory -Path $docStage -Force | Out-Null
    Get-ChildItem $docDir -File | Where-Object { $_.Extension -ne '.png' } |
        ForEach-Object { Copy-Item $_.FullName -Destination $docStage -Force }
}

$zip = Join-Path $dist "$name-v$version.zip"
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Remove-Item $stage -Recurse -Force

Write-Host ""
Write-Host "打包完成：dist\$name-v$version.zip  ($size KB)"
Write-Host "解压后选择含 manifest.json 的那一层目录，用「加载解压缩的扩展」安装。"
