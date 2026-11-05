# 编译安装器：LongNiang.exe（自解压）
#
# 用法：
#   .\build\build-installer.ps1 -Payload payload.zip -Icon build\icon.ico -Version 1.6.3
#
# 参数：
#   -Payload  可选。不给就找当前目录的 payload.zip
#   -Icon     可选。不给就用 build\icon.ico（没有图标也能编，只是任务栏没图标）
#   -Version  写进文件版本信息

param(
    [string]$Payload = "payload.zip",
    [string]$Icon = "build\icon.ico",
    [string]$Version = "1.0.0"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path $csc)) { throw "找不到 csc.exe：$csc（需要 .NET Framework 4.x）" }
if (-not (Test-Path $Payload)) { throw "找不到 payload.zip：$Payload" }

$out = Join-Path $root 'LongNiang.exe'
$sfx = Join-Path $root 'installer\Sfx.cs'
$info = Join-Path $root 'installer\AssemblyInfo.cs'

# 版本号写进程序集信息（临时文件，不污染源码）
$tmpInfo = Join-Path $env:TEMP "AssemblyInfo-$([guid]::NewGuid().ToString('N')).cs"
$text = [System.IO.File]::ReadAllText($info, [System.Text.Encoding]::UTF8)
$text = $text -replace '\d+\.\d+\.\d+\.\d+', "$Version.0"
[System.IO.File]::WriteAllText($tmpInfo, $text, (New-Object System.Text.UTF8Encoding($true)))

$args = @(
    '/nologo', '/target:winexe', "/out:$out",
    "/resource:$Payload,payload.zip",
    '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    $sfx, $tmpInfo
)
if (Test-Path $Icon) { $args = @("/win32icon:$Icon") + $args }

& $csc @args
if ($LASTEXITCODE -ne 0) { throw '编译失败' }

Remove-Item $tmpInfo -ErrorAction SilentlyContinue
Write-Host "编好了：$out" -ForegroundColor Green
Write-Host ("大小：" + [math]::Round((Get-Item $out).Length / 1MB, 1) + " MB")
