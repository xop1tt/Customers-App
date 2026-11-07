<div align="center">

<img src="macos/Resources/AppIcon-1024.png" alt="Иконка Customers" width="128" height="128">

# Customers

**Бесплатное приложение для macOS и Windows, которое само находит заказчиков на разработку**<br>
сайты · Telegram-боты · приложения · автоматизация · CRM · доработки

[![Последний релиз](https://img.shields.io/github/v/release/xop1tt/CLIENTS?label=%D1%80%D0%B5%D0%BB%D0%B8%D0%B7&color=2ea44f)](https://github.com/xop1tt/CLIENTS/releases/latest)
[![Загрузки](https://img.shields.io/github/downloads/xop1tt/CLIENTS/total?label=%D0%B7%D0%B0%D0%B3%D1%80%D1%83%D0%B7%D0%BA%D0%B8)](https://github.com/xop1tt/CLIENTS/releases)
[![macOS 14+](https://img.shields.io/badge/macOS-14%2B-000000?logo=apple&logoColor=white)](https://github.com/xop1tt/CLIENTS/wiki/Установка)
[![Windows 10+](https://img.shields.io/badge/Windows-10%2B-0078D4?logo=windows&logoColor=white)](https://github.com/xop1tt/CLIENTS/wiki/Установка)
[![SwiftUI](https://img.shields.io/badge/SwiftUI-native-F05138?logo=swift&logoColor=white)](macos)
[![WinUI 3](https://img.shields.io/badge/WinUI%203-.NET%2010-512BD4?logo=dotnet&logoColor=white)](windows)
<br>
[![Tests](https://github.com/xop1tt/CLIENTS/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/xop1tt/CLIENTS/actions/workflows/tests.yml)
[![macOS app](https://github.com/xop1tt/CLIENTS/actions/workflows/macos-app.yml/badge.svg?branch=main)](https://github.com/xop1tt/CLIENTS/actions/workflows/macos-app.yml)
[![Windows app](https://github.com/xop1tt/CLIENTS/actions/workflows/windows.yml/badge.svg?branch=main)](https://github.com/xop1tt/CLIENTS/actions/workflows/windows.yml)
[![Cloud](https://github.com/xop1tt/CLIENTS/actions/workflows/cloud.yml/badge.svg?branch=main)](https://github.com/xop1tt/CLIENTS/actions/workflows/cloud.yml)
[![Лицензия: PIBUL 1.0](https://img.shields.io/badge/%D0%BB%D0%B8%D1%86%D0%B5%D0%BD%D0%B7%D0%B8%D1%8F-PIBUL%201.0-blue)](LICENSE)

[**⬇️ Скачать (macOS и Windows)**](https://github.com/xop1tt/CLIENTS/releases/latest) ·
[**📖 Документация (Wiki)**](https://github.com/xop1tt/CLIENTS/wiki) ·
[**🐞 Сообщить о проблеме**](https://github.com/xop1tt/CLIENTS/issues/new)

</div>

---

Customers просматривает открытые источники: RSS-ленты бирж (FL.ru и любые другие), публичные Telegram-каналы,
сообщества VK и организации из OpenStreetMap. Он отбирает настоящие заказы, оценивает каждый по понятным правилам и
складывает в удобную таблицу на вашем компьютере (Mac или ПК с Windows). **Всё бесплатно навсегда**: без подписок, пробных периодов, платных API и AI-сервисов.

## ✨ Возможности

| | |
|---|---|
| 🔎 **Поиск в один клик** | Кнопка «Найти лиды» (⌘R) или автопроверка по расписанию, в том числе в фоне из строки меню |
| 📡 **Четыре вида источников** | RSS/Atom-ленты, Telegram-каналы, VK-сообщества, OpenStreetMap с проверкой сайтов организаций |
| 🎯 **Понятная оценка** | 0–100 баллов и причины: тематика, явный запрос, бюджет, срочность, спам. Факты отдельно от предположений |
| 🧹 **Без дублей и мусора** | Дедупликация по ID и отпечатку текста, домена, телефона. Исключения: домены, телефоны, email, ваша база клиентов из CSV |
| 🗂 **Удобная работа с лидами** | Три панели, фильтры, поиск, избранное, архив, заметки, история, черновик первого обращения |
| 📞 **Связь прямо из карточки** | Звонок по `tel:` (FaceTime, iPhone, «Связь с телефоном»), письмо через почтовую программу или напрямую по SMTP (Gmail, Яндекс, Mail.ru, iCloud и любой сервер) |
| ☁️ **Синхронизация (по желанию)** | Вход по почте и данные на нескольких компьютерах, в том числе Mac и Windows вместе, через ваш бесплатный проект Supabase |
| 💾 **Данные под контролем** | База шифруется (SQLCipher), ежедневные резервные копии, выгрузка копий на облачные диски (Google Диск, Dropbox, OneDrive, Яндекс Диск, pCloud, MEGA, WebDAV/Nextcloud; на macOS и в iCloud Drive), экспорт в CSV и JSON, отправка в Bitrix24, Notion и через вебхук (Make, n8n, Zapier) |
| 🔄 **Автообновление** | Новая версия ставится из приложения со сверкой SHA-256 |
| 🎨 **Нативные приложения** | macOS: SwiftUI, строка меню. Windows: WinUI 3, значок в области уведомлений, работа в фоне и автозапуск. Светлая и тёмная тема, акцентный цвет |
| 🔒 **Приватность** | Своих серверов и аналитики нет: у локальной учётной записи лиды не покидают ваш компьютер. Секреты лежат в Связке ключей macOS и в DPAPI на Windows |

## 🚀 Быстрый старт

Готовые файлы лежат на странице [последнего релиза](https://github.com/xop1tt/CLIENTS/releases/latest): один релиз содержит установщики для обеих систем и файлы `.sha256` для проверки.

### 🍎 macOS (14 Sonoma и новее)

1. Скачайте `Customers-vX.Y.Z-macOS.dmg`.
2. Откройте dmg и перетащите **Customers** в «Программы».
3. При первом запуске: правый клик по приложению → **Открыть** → **Открыть**
   (сборка без платной подписи Apple, macOS спросит один раз).
4. Создайте учётную запись, добавьте в «Источниках» свои Telegram-каналы, RSS-ленты или город и нажмите **«Найти лиды»** (⌘R).

Универсальная сборка: Apple Silicon и Intel. Обновления ставятся из самого приложения («Customers → Проверить обновления…»).

### 🪟 Windows (10 версии 1809 и новее, 11; x64)

1. Скачайте `Customers-vX.Y.Z-Windows-x64-Setup.exe`.
2. Запустите установщик (права администратора не нужны, .NET и Visual Studio не нужны).
   Если SmartScreen пишет «Windows защитила ваш компьютер», нажмите **Подробнее → Выполнить в любом случае**
   (установщик без платной подписи Microsoft).
3. Создайте учётную запись, добавьте источники и нажмите **«Найти лиды»**.

Данные лежат в `%LOCALAPPDATA%\Customers` и при обновлении и удалении по умолчанию сохраняются. Приложение само предлагает новую версию.
Подробнее: [Wiki → Установка](https://github.com/xop1tt/CLIENTS/wiki/Установка), [windows/README.md](windows/README.md), сборка из исходников: [Wiki → Разработка и сборка](https://github.com/xop1tt/CLIENTS/wiki/Разработка-и-сборка).

Обе версии работают с одним облачным аккаунтом и одним форматом экспорта, поэтому можно пользоваться и Mac, и Windows.

## 📖 Документация

Подробная документация переехала в **[Wiki](https://github.com/xop1tt/CLIENTS/wiki)**:

| Пользователям | Продвинутым |
|---|---|
| [Установка](https://github.com/xop1tt/CLIENTS/wiki/Установка) | [Поиск в GitHub Actions](https://github.com/xop1tt/CLIENTS/wiki/Поиск-в-GitHub-Actions) (Python, Notion, Telegram) |
| [Работа с приложением](https://github.com/xop1tt/CLIENTS/wiki/Работа-с-приложением) | [Внешние интеграции и бесплатные лимиты](https://github.com/xop1tt/CLIENTS/wiki/Внешние-интеграции) |
| [Источники](https://github.com/xop1tt/CLIENTS/wiki/Источники) | [Разработка и сборка](https://github.com/xop1tt/CLIENTS/wiki/Разработка-и-сборка) |
| [Оценка и фильтры](https://github.com/xop1tt/CLIENTS/wiki/Оценка-и-фильтры) | [Безопасность и конфиденциальность](https://github.com/xop1tt/CLIENTS/wiki/Безопасность-и-конфиденциальность) |
| [Учётные записи и облако](https://github.com/xop1tt/CLIENTS/wiki/Учётные-записи-и-облако) | [Ограничения и планы](https://github.com/xop1tt/CLIENTS/wiki/Ограничения-и-планы) |
| [Резервные копии и экспорт](https://github.com/xop1tt/CLIENTS/wiki/Резервные-копии-и-экспорт) · [Экспорт в CRM](https://github.com/xop1tt/CLIENTS/wiki/Экспорт-в-CRM) | [Настройка облака Supabase](docs/cloud-setup.md) · [устройство облака](docs/cloud.md) |
| [Интеграции: диски, почта, звонки](https://github.com/xop1tt/CLIENTS/wiki/Интеграции-приложения) | [Тестирование](https://github.com/xop1tt/CLIENTS/wiki/Тестирование) · [Аудит источников](docs/research.md) |
| [Обновления и отчёты о сбоях](https://github.com/xop1tt/CLIENTS/wiki/Обновления-и-отчёты-о-сбоях) | [macOS: исходники](macos/README.md) · [Windows: исходники и документы](windows/README.md) |
| [Частые проблемы](https://github.com/xop1tt/CLIENTS/wiki/Частые-проблемы) | |

## 📡 Откуда берутся лиды

| Источник | Доступ | Что находит |
|---|---|---|
| RSS-ленты (FL.ru и любые другие) | бесплатно | заказы с бирж: описание, бюджет, ссылка |
| Telegram-каналы | бесплатно | посты публичных каналов с заказами и контактами |
| VK-сообщества | бесплатный ключ | посты открытых сообществ |
| OpenStreetMap + проверка сайтов | бесплатно | организации без сайта или с устаревшим сайтом |

Kwork, Habr Freelance, Яндекс Карты, 2ГИС и поисковые системы не подключены: бесплатно и в рамках правил их
использовать нельзя. Причины: [Wiki → Источники](https://github.com/xop1tt/CLIENTS/wiki/Источники#что-не-подключено-и-почему).

## 🧱 Из чего состоит

```
macos/        приложение для macOS (SwiftUI): поиск, база лидов, учётные записи, облако, диски, почта
windows/      приложение для Windows (C#, .NET 10, WinUI 3): те же возможности, установщик Inno Setup
supabase/     необязательное облако: миграции Postgres, Edge Functions, тесты
src/leadgen/  Python-версия для поиска по расписанию в GitHub Actions (Notion + Telegram)
docs/         облако и аудит источников
wiki/         исходники Wiki: публикуются в Wiki workflow после слияния в main
```

## 📦 Релизы и проверки

Один workflow `Release` (`.github/workflows/release.yml`) по тегу `vX.Y.Z` или `vX.Y.Z.W` (или вручную из Actions) параллельно
собирает dmg для macOS и установщик для Windows и создаёт **один** GitHub Release с обоими файлами и контрольными суммами SHA-256.
Если любая сборка упала, релиз не создаётся. Проверки на каждый PR: `Tests` (Python), `macOS app`, `Windows app`
(сборка WinUI, тесты на Windows и Linux, запуск `--smoke`, установка и удаление), `Cloud`, CodeQL.

## 🔒 Безопасность

Уязвимость? Не создавайте публичный issue, напишите через **Security → Report a vulnerability**.
Подробности: [SECURITY.md](SECURITY.md).

## 📄 Лицензия

Customers распространяется по лицензии **Personal & Internal Business Use License (PIBUL) 1.0**: его можно
бесплатно использовать для себя и внутри своей организации. Продажа, коммерческое распространение и публикация копий
без письменного разрешения автора запрещены. Полный текст: [LICENSE](LICENSE).

<div align="center">
<sub>© 2026 xop1tt · <a href="LICENSE">PIBUL 1.0</a></sub>
</div>
