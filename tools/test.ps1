# 起点极简 · 一键自检（PowerShell 7）
#
#   pwsh -File tools\test.ps1
#
# 依次执行：
#   1) 静态自检      tools/validate.mjs              清单 / 引用 / 语法 / CSS 规则扫描 / 事故回归
#   2) 计算样式自检  tools/audit.html                日间 + 夜间，逐条断言 getComputedStyle
#   3) 行为自检      tools/content-test.html         页游清理 / 悬浮按钮 / 主题切换 / 结构导出
#   4) 阅读页守卫    tools/chapter/reader-test.html  真实 /chapter/ 路径下验证零注入、零改动
#   5) 详情页日间锁  tools/book/detail-test.html     真实 /book/ 路径下验证固定日间、拒绝日夜切换
#
# 全部通过时退出码为 0。

param([string]$Edge = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Edge) {
    $cands = @(
        (Join-Path ${env:ProgramFiles} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
    )
    $Edge = ($cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)
}
if (-not $Edge) { throw '找不到 Edge / Chrome，请用 -Edge "路径\msedge.exe" 指定。' }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    $cand = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path $cand) { $node = $cand }
}
if (-not $node) { throw '找不到 node，请把 node 加入 PATH。' }

$totalFail = 0
$fileUrl = 'file:///' + ($root -replace '\\', '/')

# 整个套件共用一个临时 profile：
#   连开多个 headless 实例时，若每次都新建再删除 profile，偶发出现最后一次拿不到
#   --dump-dom 输出的情况（删除动作与 Edge 后台进程仍在写盘互相打架）。
#   共用 + 「必须拿到 SUMMARY 行才算成功」的重试，可以让自检稳定可重复。
$profile = Join-Path $env:TEMP 'qdmin-headless-profile'
if (Test-Path $profile) { Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $profile -Force | Out-Null

function Invoke-HeadlessCheck {
    param([string]$Name, [string]$Url, [string]$Pattern)

    Write-Host ''
    Write-Host "===== $Name =====" -ForegroundColor Cyan

    $lines = @()
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        $dom = & $Edge --headless=new --disable-gpu --hide-scrollbars --no-first-run `
            "--user-data-dir=$profile" --virtual-time-budget=8000 --dump-dom $Url 2>$null | Out-String
        $lines = ($dom -replace '<pre id="report">', "`n<pre id=`"report`">`n" -split "`r?`n") |
            Where-Object { $_ -match $Pattern } | ForEach-Object { $_.Trim() }
        # 只有拿到 SUMMARY 行才算这次渲染完整（避免 dump 早于页面断言写回）
        if ($lines | Where-Object { $_ -match 'SUMMARY' }) { break }
        Start-Sleep -Milliseconds 700
    }

    if (-not $lines) {
        Write-Host '  没有取到任何结果（页面可能未能渲染）' -ForegroundColor Red
        $script:totalFail++
        return
    }
    foreach ($l in $lines) { Write-Host "  $l" }

    # 失败数直接读 SUMMARY 行里的 fail=N。
    # 别再用 '| FAIL' 之类的模式去数行——页面输出格式是「CT FAIL | 描述」，
    # 管道在 FAIL 之后，那种模式永远匹配不到（这个坑踩过一次）。
    $summary = $lines | Where-Object { $_ -match 'SUMMARY' } | Select-Object -First 1
    if ($summary -match 'fail=(\d+)') {
        $script:totalFail += [int]$Matches[1]
    } else {
        Write-Host '  SUMMARY 行格式异常，无法统计失败数' -ForegroundColor Red
        $script:totalFail++
    }
}

Write-Host '===== 1/6 静态自检 =====' -ForegroundColor Cyan
& $node 'tools\validate.mjs'
if ($LASTEXITCODE -ne 0) { $totalFail++ }

Invoke-HeadlessCheck -Name '2/6 计算样式自检 · 日间' -Url "$fileUrl/tools/audit.html?theme=light" `
    -Pattern '^\s*(AUDIT) (PASS|FAIL|SUMMARY)'
Invoke-HeadlessCheck -Name '2/6 计算样式自检 · 夜间' -Url "$fileUrl/tools/audit.html?theme=dark" `
    -Pattern '^\s*(AUDIT) (PASS|FAIL|SUMMARY)'
Invoke-HeadlessCheck -Name '3/6 行为自检 · 站点页' -Url "$fileUrl/tools/content-test.html" `
    -Pattern '^\s*(CT) (PASS|FAIL|SUMMARY)'
Invoke-HeadlessCheck -Name '4/6 阅读页守卫自检' -Url "$fileUrl/tools/chapter/reader-test.html" `
    -Pattern '^\s*(CT) (PASS|FAIL|SUMMARY)'
Invoke-HeadlessCheck -Name '5/6 书籍详情页固定日间自检' -Url "$fileUrl/tools/book/detail-test.html" `
    -Pattern '^\s*(CT) (PASS|FAIL|SUMMARY)'
Invoke-HeadlessCheck -Name '6/6 个人中心夜间自适应 + 书架封面自检' -Url "$fileUrl/tools/bookcase/list-test.html" `
    -Pattern '^\s*(CT) (PASS|FAIL|SUMMARY)'

Write-Host ''
if ($totalFail -eq 0) {
    Write-Host '全部自检通过。' -ForegroundColor Green
    exit 0
}
Write-Host "自检失败：$totalFail 处未通过。" -ForegroundColor Red
exit 1
