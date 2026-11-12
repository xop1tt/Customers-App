# Проверка установщика: тихая установка в чистую папку, проверка регистрации ссылок leadgenerator:,
# установка поверх с сохранением данных пользователя, удаление.
param(
    [Parameter(Mandatory = $true)][string]$Artifacts
)

$ErrorActionPreference = 'Stop'
$Artifacts = (Resolve-Path $Artifacts).Path
$pattern = 'Customers-v*-Windows-x64-Setup.exe'; $exeName = 'Customers.exe'; $scheme = 'leadgenerator'
$guid = '6B0F7C1E-3A52-4C58-9E41-5B7D2A9C1F30'; $dataName = 'Customers'
$setup = Get-ChildItem $Artifacts -Filter $pattern | Select-Object -First 1
if (-not $setup) { throw 'Установщик не найден' }

$dir = Join-Path $env:RUNNER_TEMP "customers-installed"
if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
$log = Join-Path $Artifacts 'install.log'

Write-Host "Установка $($setup.Name) в $dir"
$install = Start-Process -FilePath $setup.FullName -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', "/DIR=`"$dir`"", "/LOG=`"$log`"") -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Установщик завершился с кодом $($install.ExitCode)" }

$exe = Join-Path $dir $exeName
if (-not (Test-Path $exe)) { throw "После установки нет $exeName" }
$uninstaller = Join-Path $dir 'unins000.exe'
if (-not (Test-Path $uninstaller)) { throw 'После установки нет программы удаления' }

$protocol = Get-ItemProperty "HKCU:\Software\Classes\$scheme\shell\open\command" -ErrorAction SilentlyContinue
if (-not $protocol -or $protocol.'(default)' -notlike "*$exeName*") { throw "Ссылки ${scheme}: не зарегистрированы" }

$uninstallKey = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { $_.PSChildName -like "*$guid*" }
if (-not $uninstallKey) { throw 'Приложение не появилось в списке установленных (Параметры → Приложения)' }

# Данные пользователя должны пережить обновление: ставим поверх той же версией.
$marker = Join-Path $env:LOCALAPPDATA $dataName
New-Item -ItemType Directory -Path $marker -Force | Out-Null
Set-Content (Join-Path $marker 'keep.txt') 'data'
# Так же, как делает само приложение при обновлении: тихо и с закрытием работающей копии.
$again = Start-Process -FilePath $setup.FullName -ArgumentList @('/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/CURRENTUSER', "/DIR=`"$dir`"") -PassThru
if (-not $again.WaitForExit(300000)) { $again | Stop-Process -Force; throw 'Установка поверх не завершилась за 5 минут' }
if ($again.ExitCode -ne 0) { throw "Установка поверх завершилась с кодом $($again.ExitCode)" }
if (-not (Test-Path (Join-Path $marker 'keep.txt'))) { throw 'Установка поверх удалила данные пользователя' }
Start-Sleep -Seconds 2

Write-Host 'Удаление'
$remove = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait -PassThru
if ($remove.ExitCode -ne 0) { throw "Удаление завершилось с кодом $($remove.ExitCode)" }
Start-Sleep -Seconds 2
if (Test-Path $exe) { throw "После удаления $exeName остался на диске" }
if (Test-Path "HKCU:\Software\Classes\$scheme") { throw "После удаления остались записи ${scheme}:" }
if (-not (Test-Path (Join-Path $marker 'keep.txt'))) { throw 'Тихое удаление затронуло данные пользователя' }
Remove-Item $marker -Recurse -Force
Write-Host "Установка, обновление поверх и удаление работают."
