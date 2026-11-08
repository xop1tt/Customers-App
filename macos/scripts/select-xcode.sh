#!/usr/bin/env bash
# Выбирает самый новый установленный Xcode 26+ (SDK macOS 26): с ним приложение получает настоящий
# Liquid Glass (glassEffect, стеклянные кнопки и переключатели) на macOS 26 и новее. На macOS 14–15
# то же приложение работает со своей имитацией стекла. Если Xcode 26+ на раннере нет — остаётся
# Xcode по умолчанию: код собирается и с ним (стеклянные API закрыты `#if compiler(>=6.2)`).
# Записывает XCODE_ID в $GITHUB_ENV, чтобы кэш сборки не смешивал результаты разных Xcode.
set -euo pipefail
pick=""
for app in /Applications/Xcode_*.app; do
  [[ -d "$app" ]] || continue
  v="${app#/Applications/Xcode_}"; v="${v%.app}"
  major="${v%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || continue
  (( major >= 26 )) || continue
  # Бета-версии пропускаем.
  [[ "$v" =~ ^[0-9.]+$ ]] || continue
  pick="$(printf '%s\n%s\n' "$pick" "$app" | sed '/^$/d' | sort -V | tail -1)"
done
if [[ -n "$pick" ]]; then
  echo "Xcode для сборки: $pick"
  sudo xcode-select -s "$pick/Contents/Developer"
else
  echo "Xcode 26+ не найден, остаётся $(xcode-select -p)"
fi
xcodebuild -version
swift --version
id="$(xcodebuild -version | tr -s ' \n' '-' )"
if [[ -n "${GITHUB_ENV:-}" ]]; then echo "XCODE_ID=${id}" >> "$GITHUB_ENV"; fi
