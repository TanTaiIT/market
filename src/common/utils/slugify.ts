/**
 * Chuyển chuỗi tiếng Việt có dấu thành slug URL-friendly.
 * Ví dụ: "Bán iPhone 15 Pro Max" -> "ban-iphone-15-pro-max"
 */
export function slugify(str = ''): string {
  return String(str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // bỏ dấu (combining diacritical marks U+0300–U+036F)
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Slug kèm hậu tố ngắn để đảm bảo unique (dùng cho listing).
 */
export function slugifyWithSuffix(str: string, suffix?: string | number): string {
  const base = slugify(str)
  return suffix != null ? `${base}-${suffix}` : base
}
