#!/bin/bash
# Упаковывает собранное приложение в установщик .dmg: окно с приложением и ярлыком «Программы»,
# куда его нужно перетащить. Использование: scripts/make-dmg.sh <выходной.dmg> <путь к Customers.app>
# Имя приложения в образе берётся из пути: Customers.app (Stable) или «Customers Beta.app» (Beta).
# Поэтому Beta, перетащенная в «Программы», ложится рядом со Stable, а не поверх неё.
set -euo pipefail
DMG="$1"
APP="$2"
NAME="$(basename "$APP" .app)"
STAGE="$(mktemp -d)/$NAME"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/$NAME.app"
ln -s /Applications "$STAGE/Applications"
cp "$APP/Contents/Resources/icon.icns" "$STAGE/.VolumeIcon.icns"
rm -f "$DMG"
hdiutil create -volname "$NAME" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$DMG"
# Значок тома: флаг «custom icon» на корне образа (SetFile есть в Command Line Tools).
if command -v SetFile >/dev/null; then
  RW="$(mktemp -d)/rw.dmg"
  hdiutil convert "$DMG" -format UDRW -o "$RW" >/dev/null
  MNT="$(hdiutil attach -nobrowse -noautoopen "$RW" | awk -F'\t' '/\/Volumes\//{print $NF}')"
  SetFile -a C "$MNT" || true
  hdiutil detach "$MNT" >/dev/null
  rm -f "$DMG"
  hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$DMG" >/dev/null
fi
hdiutil verify "$DMG"
echo "Готово: $DMG"
