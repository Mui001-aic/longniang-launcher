# 编译卸载器：卸载龙娘跑团.exe
#
# 用法：
#   .\build\build-uninstaller.ps1 -Icon build\icon.ico
#
# 编好以后把它放进安装目录的一级目录（payload 里也放一份），双击即可卸载。

param(
    [string]$Icon = "build\icon.ico"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path $csc)) { throw "找不到 csc.exe：$csc（需要 .NET Framework 4.x）" }

$out = Join-Path $root '卸载龙娘跑团.exe'
$src = Join-Path $root 'installer\Uninstall.cs'

$args = @(
    '/nologo', '/target:winexe', "/out:$out",
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    $src
)
if (Test-Path $Icon) { $args = @("/win32icon:$Icon") + $args }

& $csc @args
if ($LASTEXITCODE -ne 0) { throw '编译失败' }

Write-Host "编好了：$out" -ForegroundColor Green
Write-Host '把它复制到安装目录的一级目录（和 electron\ 同级）'
