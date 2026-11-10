-- Временно снимаем наши ограничения на количество попыток отправки кодов и писем (по просьбе владельца).
-- Остаются: общий суточный потолок (у Gmail жёсткий предел ~500 писем в сутки, превышение блокирует ящик) и
-- ограничения самого Supabase Auth (они настраиваются в панели Supabase, не здесь).
-- Вернуть прежние значения: см. docs/cloud-setup.md, шаг 10. Повторное применение безопасно.

update private.email_limits set
    signup_resend_cooldown = interval '0',
    recovery_cooldown = interval '0',
    email_change_cooldown = interval '0',
    per_email_daily_max = 1000,
    device_hourly_max = 1000,
    device_daily_max = 1000,
    ip_hourly_max = 1000,
    ip_daily_max = 1000,
    global_daily_max = 400
where id = 1;
