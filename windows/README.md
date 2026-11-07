# Customers для Windows

Нативная версия Customers для Windows 10 и 11: те же источники, оценка, дедупликация, экспорт и облачная синхронизация, что и в приложении для macOS. Бесплатная, без подписок, платных API и обязательных внешних сервисов.

| | |
|---|---|
| Язык и платформа | C# 14, .NET 10, WinUI 3 (Windows App SDK 1.8), XAML, Fluent 2 |
| Система | Windows 10 1809 и новее, Windows 11 (x64) |
| Данные | SQLite с шифрованием SQLCipher, ключ защищён DPAPI |
| Установка | один установщик `Customers-vX.Y.Z-Windows-x64-Setup.exe`, ни Visual Studio, ни .NET SDK, ни среда выполнения не нужны |

## Документы

| Файл | О чём |
|---|---|
| [docs/install.md](docs/install.md) | Установка, обновление, удаление, где лежат данные |
| [docs/run.md](docs/run.md) | Запуск, командная строка, режимы проверки |
| [docs/build.md](docs/build.md) | Сборка из исходников и сборка установщика |
| [docs/architecture.md](docs/architecture.md) | Модули и устройство приложения |
| [docs/technologies.md](docs/technologies.md) | Используемые технологии и почему выбраны именно они |
| [docs/macos-sync.md](docs/macos-sync.md) | Как Windows и macOS обмениваются данными |
| [docs/testing.md](docs/testing.md) | Тесты, проверки в CI, что проверено автоматически, а что нет |
| [docs/integrations.md](docs/integrations.md) | Диски, почта, звонки, работа в фоне и ключи OAuth |
| [docs/status.md](docs/status.md) | Что готово, что не перенесено и известные ограничения |

## Структура

```
windows/
├─ src/
│  ├─ Customers.Core/          бизнес-логика без интерфейса: поиск, оценка, база, облако, экспорт, учётные записи
│  ├─ Customers.Presentation/  модели представления без типов интерфейса (тестируются на Linux и Windows)
│  └─ Customers.App/           приложение WinUI 3: окна, страницы, диалоги, установка обновлений
├─ tests/                      Customers.Core.Tests и Customers.Presentation.Tests (xUnit)
├─ installer/Customers.iss     сценарий установщика Inno Setup
├─ tools/                      smoke.ps1, installer-check.ps1, ui-check (проверка компиляции интерфейса на Linux)
└─ docs/
```

## Быстрый старт для разработчика

```powershell
cd windows
dotnet test tests/Customers.Core.Tests
dotnet test tests/Customers.Presentation.Tests
dotnet run --project src/Customers.App -r win-x64
```

Подробности и все команды: [docs/build.md](docs/build.md).

## Сборки и проверки

Workflow `Windows app` (`.github/workflows/windows.yml`) на каждом изменении папки `windows/`:
собирает ядро и интерфейс (предупреждения компилятора считаются ошибками), запускает тесты на Windows и Linux,
публикует автономную сборку, запускает её в режиме `--smoke`, собирает установщик, ставит его, запускает установленное приложение,
ставит поверх и удаляет. Workflow `Windows release` прикрепляет установщик к релизу GitHub рядом с версией для macOS.
Файлы macOS и их workflow не затронуты.
