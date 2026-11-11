#!/bin/bash
# Учёт и применение миграций рабочего проекта (workflow migrate.yml, docs/MIGRATIONS.md).
# Использование: DB_URL=… supabase/scripts/migrate.sh status|push|register
# DB_URL — строка подключения Session pooler; в журнал не выводится.
set -euo pipefail
cd "$(dirname "$0")/../.."
ACTION="${1:-status}"
CLI="npx --yes ${SUPABASE_CLI:-supabase@2.122.1}"

versions() { ls supabase/migrations/*.sql | xargs -n1 basename | cut -d_ -f1; }
# Последняя миграция, применённая вручную до пакета A2 (read-only проверка рабочего проекта 2026-11-11).
# register записывает в историю только миграции до неё включительно: более новые применяет push.
MANUAL_UNTIL=20261111100000

applied_count() {
  # История CLI: supabase_migrations.schema_migrations. Нет схемы — истории нет.
  psql "$DB_URL" -At -v ON_ERROR_STOP=1 -c \
    "select case when to_regclass('supabase_migrations.schema_migrations') is null then 0
             else (select count(*) from supabase_migrations.schema_migrations) end"
}

case "$ACTION" in
  status)
    $CLI migration list --db-url "$DB_URL"
    ;;
  push)
    if [[ "$(applied_count)" == "0" ]]; then
      echo "::error::История миграций пуста: сначала запустите action=register (один раз), иначе db push применит все миграции заново."
      exit 1
    fi
    echo "Ждут применения:"
    $CLI db push --db-url "$DB_URL" --dry-run
    $CLI db push --db-url "$DB_URL"
    $CLI migration list --db-url "$DB_URL"
    ;;
  register)
    if [[ "$(applied_count)" != "0" ]]; then
      echo "::error::История уже есть — register нужен только один раз. Используйте status или push."
      exit 1
    fi
    # Все файлы применены вручную до пакета A2 (проверено read-only запросом 2026-11-11, docs/MIGRATIONS.md).
    # shellcheck disable=SC2046
    $CLI migration repair --status applied $(versions | awk -v m="$MANUAL_UNTIL" '$1 <= m') --db-url "$DB_URL"
    $CLI migration list --db-url "$DB_URL"
    ;;
  *)
    echo "Нужно: status | push | register"; exit 2 ;;
esac
