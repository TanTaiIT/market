/**
 * Dò chữ NHẢM — "gggggggghhljflkajsdlf", "jasldjf laksdfoiuasodf" — hàm THUẦN, không chạm DB.
 *
 * Vị trí trong hệ: một `MachineHold`, KHÔNG phải một lượt từ chối. `reviewByMachine` chỉ từ
 * chối vì cụm từ cấm ("phép kiểm ít oan sai nhất"); mọi nghi ngờ còn lại để người thật nhìn.
 * Đây là heuristic nên nó BẮT BUỘC nằm ở nhóm sau: cái giá của một lần đoán sai phải là một
 * cái liếc mắt của người duyệt, không phải một tin thật bị đánh trượt.
 *
 * Vì sao heuristic chứ không từ điển: tiếng Việt viết không dấu là hợp lệ và rất phổ biến
 * ("dien thoai cu"), tên riêng/model máy thì vô hạn ("SM-A515F", "Xiaomi"), nên mọi từ điển
 * đều vừa thiếu vừa thừa. Bốn dấu hiệu dưới đây không cần biết từ nào có thật — chúng chỉ đo
 * những thứ tiếng Việt KHÔNG BAO GIỜ làm.
 *
 * Ngưỡng chọn theo hướng THÀ SÓT CÒN HƠN OAN: tin nhảm lọt qua thì vẫn còn người duyệt phía
 * sau, còn oan một tin thật là một người bán bị chặn mà không hiểu vì sao.
 */

/** Dấu tiếng Việt → chữ cái gốc. `đ` là PHỤ ÂM, không gộp về `d` cũng được nhưng gộp thì gọn. */
function baseLatin(text: string): string {
  return text
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/đ/g, 'd')
    .replaceAll(/Đ/g, 'D')
    .toLowerCase()
}

/** `y` tính là NGUYÊN ÂM: tiếng Việt dùng nó như nguyên âm ("mỹ", "quý"), khác tiếng Anh. */
const VOWELS = new Set('aeiouy')

const GIBBERISH = {
  /** Token ngắn hơn chừng này không xét: từ viết tắt (USB, HDMI, SSD) và từ ngắn nằm hết ở đây. */
  MIN_TOKEN: 5,
  /** Một token đủ dài mà dính dấu hiệu nào cũng đủ kết luận — không cần token thứ hai. */
  HARD_TOKEN: 8,
  /** `gggg`. Tiếng Việt không có chữ cái nào lặp 3 lần liền, nên 4 là đã rất chắc. */
  SAME_CHAR_RUN: 4,
  /** Chùm phụ âm dài nhất của tiếng Việt là `ngh` (3). 5 là ngoài mọi khả năng. */
  CONSONANT_RUN: 5,
  /**
   * Tiếng Việt rất nhiều nguyên âm — tỉ lệ thật thường 0.4–0.5.
   *
   * 0.15 chứ không phải 0.2: "Switch" và "Sports" đều ra 0.167, và một tựa như "Nintendo
   * Switch Sports" không được phép thành nghi phạm. Ngưỡng này đã đo trên đúng ca đó.
   */
  MIN_VOWEL_RATIO: 0.15,
  /**
   * `asdf`, `fdsa` — gõ bừa theo hàng phím.
   *
   * 4 chứ không 5, và con số này ĐO ĐƯỢC chứ không đoán: quét 215 tin thật trên `market-dev`
   * thì chỉ đúng hai token (≥5 chữ, không chứa số) chạm ngưỡng 4 — "kkkkkkklklkkkkkk" và
   * "hgjghghfhffhf" — cả hai đều là chữ nhảm. Để ở 5 thì `fdsafdsa` (chuỗi 4) lọt qua.
   */
  KEYBOARD_RUN: 4,
  /** Token ngắn (5–7) chỉ là nghi ngờ nhẹ; cần hai cái mới đủ kết luận. */
  SOFT_HITS: 2,
} as const

/** Ba hàng phím QWERTY. */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']

/**
 * Chuỗi con dài nhất mà mọi ký tự nằm liền kề trên cùng một hàng phím.
 *
 * Xét CẢ HAI chiều trong một vòng (`±1`) thay vì dựng thêm ba hàng đảo ngược: `asdf` và
 * `fdsa` đều là gõ bừa, và một phép so rẻ hơn một mảng nữa.
 */
function keyboardRun(token: string): number {
  let best = 0
  for (const row of KEYBOARD_ROWS) {
    let run = 0
    for (let i = 0; i < token.length; i += 1) {
      const here = row.indexOf(token[i]!)
      const prev = i > 0 ? row.indexOf(token[i - 1]!) : -99
      const adjacent = here >= 0 && (here === prev + 1 || here === prev - 1)
      run = adjacent ? run + 1 : here >= 0 ? 1 : 0
      best = Math.max(best, run)
    }
  }
  return best
}

/** Độ dài chuỗi lặp dài nhất (`aabbbb` → 4). */
function longestRepeat(token: string): number {
  let best = 1
  let run = 1
  for (let i = 1; i < token.length; i += 1) {
    run = token[i] === token[i - 1] ? run + 1 : 1
    best = Math.max(best, run)
  }
  return best
}

/** Chùm phụ âm liên tiếp dài nhất. */
function longestConsonantRun(token: string): number {
  let best = 0
  let run = 0
  for (const ch of token) {
    run = /[a-z]/.test(ch) && !VOWELS.has(ch) ? run + 1 : 0
    best = Math.max(best, run)
  }
  return best
}

/**
 * Một token có dấu hiệu gõ bừa không.
 *
 * Token chứa CHỮ SỐ luôn được tha: mã máy và model là phần hợp lệ nhất của một tựa tin đăng
 * ("SM-A515F", "RTX4090", "iPhone13"), và chúng vi phạm gần hết các luật dưới đây.
 */
function tokenLooksMashed(token: string): boolean {
  if (/\d/.test(token)) return false

  const letters = [...token].filter((ch) => /[a-z]/.test(ch))
  if (letters.length < GIBBERISH.MIN_TOKEN) return false

  const vowels = letters.filter((ch) => VOWELS.has(ch)).length
  return (
    longestRepeat(token) >= GIBBERISH.SAME_CHAR_RUN ||
    longestConsonantRun(token) >= GIBBERISH.CONSONANT_RUN ||
    vowels / letters.length < GIBBERISH.MIN_VOWEL_RATIO ||
    keyboardRun(token) >= GIBBERISH.KEYBOARD_RUN
  )
}

/**
 * Đoạn text có phải gõ bừa không.
 *
 * Hai cửa, và cửa đầu là cửa quan trọng: MỘT token dài mà dính dấu hiệu thì kết luận ngay —
 * không chuỗi hợp lệ nào dài 8 chữ cái mà lặp 4 lần một ký tự hoặc có 5 phụ âm liền. Token
 * ngắn (5–7) thì cần HAI cái, vì ở độ dài đó tên riêng và từ tiếng Anh vẫn lọt vào vùng nghi.
 */
export function looksMashed(text: string): boolean {
  const tokens = baseLatin(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

  let soft = 0
  for (const token of tokens) {
    if (!tokenLooksMashed(token)) continue
    if (token.length >= GIBBERISH.HARD_TOKEN) return true
    soft += 1
  }
  return soft >= GIBBERISH.SOFT_HITS
}
