// Ключ восстановления переносимой копии (G8, ADR-062). Правила совпадают с ядром (`app/portable.rs`):
// 30 знаков из алфавита без похожих символов, показывается группами по пять, вводится как удобно.

export const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const RECOVERY_KEY_LENGTH = 30;

/** Ключ без пробелов и дефисов, заглавными; null — если это не ключ восстановления. */
export function normalizeRecoveryKey(input: string): string | null {
  const key = input.replace(/[\s-]/g, "").toUpperCase();
  if (key.length !== RECOVERY_KEY_LENGTH) return null;
  for (const c of key) if (!RECOVERY_ALPHABET.includes(c)) return null;
  return key;
}

/** Группы по пять через дефис: «7KQ2M-XW9RT-…». */
export const formatRecoveryKey = (key: string) => key.match(/.{1,5}/g)?.join("-") ?? "";
