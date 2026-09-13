[CmdletBinding()]
param(
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$artifactRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDirectory '..'))
$packageRoot = Join-Path $artifactRoot 'android-test-package'
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $artifactRoot '..\..'))
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $workspaceRoot 'deliverables\CAS-Pixel11-Windows-Test-Kit-v5.zip'
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)

& (Join-Path $scriptDirectory 'test-windows-entrypoints.ps1') -PackageRoot $packageRoot

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('cas-windows-package-' + [guid]::NewGuid().ToString('N'))
$stagedPackage = Join-Path $stagingRoot 'CAS-Pixel11-Windows-Test-Kit-v5'
try {
    New-Item -ItemType Directory -Path $stagedPackage -Force | Out-Null
    Copy-Item -Path (Join-Path $packageRoot '*') -Destination $stagedPackage -Recurse -Force
    New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
    Remove-Item $OutputPath -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path $stagedPackage -DestinationPath $OutputPath -CompressionLevel Optimal
    Write-Host ('Windows test kit created: {0}' -f $OutputPath) -ForegroundColor Green
} finally {
    Remove-Item -Recurse -Force $stagingRoot -ErrorAction SilentlyContinue
}