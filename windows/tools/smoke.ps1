# Запускает Customers.exe --smoke и проверяет результат. Использование:
#   ./tools/smoke.ps1 -Exe artifacts/publish/Customers.exe -Output artifacts/smoke-publish
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string]$Output,
    [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'
$Exe = (Resolve-Path $Exe).Path
if (Test-Path $Output) { Remove-Item $Output -Recurse -Force }
New-Item -ItemType Directory -Path $Output -Force | Out-Null
$Output = (Resolve-Path $Output).Path

$process = Start-Process -FilePath $Exe -ArgumentList @('--smoke', "`"$Output`"") -PassThru
if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill($true)
    throw "Приложение не завершило проверку за $TimeoutSeconds с"
}

$resultFile = Join-Path $Output 'result.txt'
if (Test-Path $resultFile) {
    Get-Content $resultFile | ForEach-Object { Write-Host $_ }
}
else {
    $logs = Join-Path $Output 'data/logs'
    if (Test-Path $logs) { Get-ChildItem $logs -File | ForEach-Object { Write-Host "--- $($_.Name)"; Get-Content $_.FullName -Tail 60 } }
    throw "Приложение завершилось с кодом $($process.ExitCode) и не оставило result.txt"
}

$shots = @(Get-ChildItem (Join-Path $Output 'shots') -Filter *.png -ErrorAction SilentlyContinue).Count
Write-Host "Снимков экрана: $shots"
if ($process.ExitCode -ne 0) {
    throw "Проверка не пройдена, код выхода $($process.ExitCode)"
}
