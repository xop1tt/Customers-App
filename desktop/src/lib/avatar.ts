// Аватар: выбранную картинку обрезаем до квадрата и уменьшаем, чтобы она быстро синхронизировалась через облако.

export const AVATAR_SIZE = 192;
/** Серверный предел значения настройки — 64 КБ; с запасом оставляем меньше. */
export const AVATAR_MAX_CHARS = 60_000;

/** Область исходной картинки, которая попадёт в квадрат: по центру, по короткой стороне. */
export function squareCrop(width: number, height: number): { x: number; y: number; side: number } {
  const side = Math.min(width, height);
  return { x: Math.round((width - side) / 2), y: Math.round((height - side) / 2), side };
}

/** Читает файл-картинку и возвращает data-URL JPEG размером AVATAR_SIZE. */
export async function avatarFromFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Выберите файл с картинкой: PNG, JPEG или WebP.");
  const bitmap = await createImageBitmap(file);
  const { x, y, side } = squareCrop(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Не удалось обработать картинку.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  ctx.drawImage(bitmap, x, y, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bitmap.close?.();
  for (const quality of [0.86, 0.7, 0.55]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= AVATAR_MAX_CHARS) return url;
  }
  throw new Error("Картинка слишком сложная. Выберите другую.");
}
