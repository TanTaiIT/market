/**
 * Bỏ emoji khỏi log, giữ nguyên chữ số và dấu tiếng Việt.
 *
 * KHÔNG dùng \p{Emoji}: property đó khớp cả `0-9`, `#` và `*` (chúng là base của
 * keycap sequence), nên nó nuốt sạch chữ số — "POST /api/v1 201" thành "POST /api/v ".
 * \p{Extended_Pictographic} mới là "emoji thật"; ️ là variation selector đi kèm
 * (bản thân nó vô hình nên phải viết dạng escape, đừng dán ký tự thật vào source).
 */
export function removeEmoji(input: unknown): string {
  return String(input ?? '').replace(/[\p{Extended_Pictographic}️]/gu, '')
}
