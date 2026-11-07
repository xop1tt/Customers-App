# Сборка из исходников

## Что нужно

* Windows 10/11 x64.
* [.NET SDK 10](https://dotnet.microsoft.com/download) (версия закреплена в `windows/global.json`).
* Для установщика — [Inno Setup 6](https://jrsoftware.org/isinfo.php) (бесплатный).
* Visual Studio **не обязательна**: достаточно командной строки. Нужные пакеты (Windows App SDK, SDK Build Tools) подтянет NuGet.

Ядро и тесты собираются и на Linux/macOS; интерфейс WinUI — только на Windows.

## Команды

```powershell
cd windows

# тесты (на любой ОС)
dotnet test tests/Customers.Core.Tests
dotnet test tests/Customers.Presentation.Tests

# сборка и запуск интерфейса (Windows)
dotnet build src/Customers.App -c Release -r win-x64
dotnet run --project src/Customers.App -r win-x64

# автономная публикация (рядом лежит всё нужное, установка .NET не требуется)
dotnet publish src/Customers.App -c Release -r win-x64 --self-contained true -o artifacts/publish

# проверочный запуск публикации
./tools/smoke.ps1 -Exe artifacts/publish/Customers.exe -Output artifacts/smoke

# установщик (нужен Inno Setup)
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" /DAppVersion=1.0.0 /DSourceDir="$PWD\artifacts\publish" /DOutputDir="$PWD\artifacts" installer\Customers.iss

# проверка установщика: установка → запуск → установка поверх → удаление
./tools/installer-check.ps1 -Artifacts artifacts
```

Версия берётся из `Directory.Build.props`; при релизе её задаёт тег (`vX.Y.Z` → `-p:Version=X.Y.Z`).

## Строгость сборки

Предупреждения компилятора и анализаторов считаются ошибками (`TreatWarningsAsErrors`), форматирование проверяется `dotnet format whitespace --verify-no-changes`. Подавлять предупреждения вместо исправления нельзя.

## Проверка интерфейса на Linux

`tools/ui-check` компилирует C#-код `Customers.App` на Linux с заглушками WinUI-типов. Это быстрая проверка синтаксиса и типов при разработке без Windows; она **не заменяет** сборку XAML и запуск на Windows, которые выполняет CI.
