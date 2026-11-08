# Проверка установщика: тихая установка в чистую папку, запуск установленного приложения (--smoke),
# проверка регистрации ссылок leadgenerator:, удаление и сохранность данных пользователя.
param(
    [Parameter(Mandatory = $true)][string]$Artifacts
)

$ErrorActionPreference = 'Stop'
$Artifacts = (Resolve-Path $Artifacts).Path
$setup = Get-ChildItem $Artifacts -Filter 'Customers-v*-Windows-x64-Setup.exe' | Select-Object -First 1
if (-not $setup) { throw 'Установщик не найден' }

$dir = Join-Path $env:RUNNER_TEMP 'customers-installed'
if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
$log = Join-Path $Artifacts 'install.log'

Write-Host "Установка $($setup.Name) в $dir"
$install = Start-Process -FilePath $setup.FullName -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', "/DIR=`"$dir`"", "/LOG=`"$log`"") -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Установщик завершился с кодом $($install.ExitCode)" }

$exe = Join-Path $dir 'Customers.exe'
if (-not (Test-Path $exe)) { throw 'После установки нет Customers.exe' }
$uninstaller = Join-Path $dir 'unins000.exe'
if (-not (Test-Path $uninstaller)) { throw 'После установки нет программы удаления' }

$protocol = Get-ItemProperty 'HKCU:\Software\Classes\leadgenerator\shell\open\command' -ErrorAction SilentlyContinue
if (-not $protocol -or $protocol.'(default)' -notlike "*Customers.exe*") { throw 'Ссылки leadgenerator: не зарегистрированы' }

$uninstallKey = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { $_.PSChildName -like '*6B0F7C1E-3A52-4C58-9E41-5B7D2A9C1F30*' }
if (-not $uninstallKey) { throw 'Приложение не появилось в списке установленных (Параметры → Приложения)' }

& "$PSScriptRoot/smoke.ps1" -Exe $exe -Output (Join-Path $Artifacts 'smoke-installed')

# Данные пользователя должны пережить обновление: ставим поверх той же версией.
$marker = Join-Path $env:LOCALAPPDATA 'Customers'
New-Item -ItemType Directory -Path $marker -Force | Out-Null
Set-Content (Join-Path $marker 'keep.txt') 'data'
# Так же, как делает само приложение при обновлении: тихо, с закрытием работающей копии и с просьбой открыть приложение снова.
# Без -Wait: он ждёт и все дочерние процессы, а установщик как раз запускает приложение и не дожидается его закрытия.
$again = Start-Process -FilePath $setup.FullName -ArgumentList @('/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/RELAUNCH=1', '/CURRENTUSER', "/DIR=`"$dir`"") -PassThru
if (-not $again.WaitForExit(300000)) { $again | Stop-Process -Force; throw 'Установка поверх не завершилась за 5 минут' }
if ($again.ExitCode -ne 0) { throw "Установка поверх завершилась с кодом $($again.ExitCode)" }
if (-not (Test-Path (Join-Path $marker 'keep.txt'))) { throw 'Установка поверх удалила данные пользователя' }
$relaunched = $null
for ($i = 0; $i -lt 30 -and -not $relaunched; $i++) {
    Start-Sleep -Milliseconds 500
    $relaunched = Get-Process -Name 'Customers' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
}
if (-not $relaunched) { throw 'После обновления поверх (RELAUNCH=1) приложение не открылось снова' }
$relaunched | Stop-Process -Force
Start-Sleep -Seconds 2

Write-Host 'Удаление'
$remove = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait -PassThru
if ($remove.ExitCode -ne 0) { throw "Удаление завершилось с кодом $($remove.ExitCode)" }
Start-Sleep -Seconds 2
if (Test-Path $exe) { throw 'После удаления Customers.exe остался на диске' }
if (Test-Path 'HKCU:\Software\Classes\leadgenerator') { throw 'После удаления остались записи leadgenerator:' }
if (-not (Test-Path (Join-Path $marker 'keep.txt'))) { throw 'Тихое удаление затронуло данные пользователя' }
Remove-Item $marker -Recurse -Force
Write-Host 'Установка, запуск, обновление поверх и удаление работают.'
