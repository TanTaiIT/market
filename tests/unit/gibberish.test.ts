import { describe, it, expect } from 'vitest'
import { looksMashed } from '../../src/features/moderation/gibberish'

/**
 * Dò chữ gõ bừa. Hai nửa, và nửa DƯỚI mới là nửa đắt: một lần đoán sai ở đó là một người bán
 * thật bị đẩy xuống hàng đợi mà không hiểu vì sao.
 *
 * Chuỗi trong nửa dưới không bịa ra: chúng là tên hàng thật hoặc là đúng những ca đã ép tôi
 * hạ ngưỡng nguyên âm từ 0.20 xuống 0.15 ("Switch", "Sports" đều ra 0.167).
 */
describe('Dò chữ gõ bừa — bắt được thứ cần bắt', () => {
  const MASHED = [
    'gggggggghhljflkajsdlf',
    'jasldjf laksdfoiuasodfjflkasdfasd',
    'asdfghjkl',
    'qwertyuiop',
    'fdsafdsa',
    // Bốn chuỗi dưới lấy nguyên từ dữ liệu dev — người dùng thật đã gõ đúng như vậy.
    'Testtttt\nHmmmmmmmmmmmm',
    'hjhhhbbhhhg\nHhhhhhhbvvb gggg ghen',
    'Áo dài\nAaaaaaaaaaaaaaa',
    'Gratin\nHgjghghfhffhf',
  ]

  for (const text of MASHED) {
    it(`bắt: ${JSON.stringify(text.slice(0, 34))}`, () => {
      expect(looksMashed(text)).toBe(true)
    })
  }
})

describe('Dò chữ gõ bừa — KHÔNG oan tin thật', () => {
  const REAL = [
    'Bán iPhone 13 Pro Max 256GB\nMáy còn bảo hành, pin 89%, không trầy xước.',
    'Nintendo Switch Sports\nHàng chính hãng, đầy đủ hộp và phụ kiện.',
    // Không dấu là cách gõ hợp lệ và rất phổ biến — không được coi là bừa.
    'Ban gap tu lanh Sharp 165 lit\nMay chay tot, khong hu hong gi, dia chi quan Binh Thanh.',
    // Mã máy vi phạm gần hết các luật hình dạng, nên token có chữ số được tha hẳn.
    'Samsung Galaxy SM-A515F\nMáy đẹp, RTX4090 không liên quan nhưng để test mã model.',
    'Tủ lạnh Electrolux inverter\nDùng 2 năm, còn rất tốt.',
    'Ổ cứng SSD NVMe 1TB\nHDMI, USB, LCD — mấy từ viết tắt ngắn không được tính là bừa.',
    'nghiêng nghiêng nghiêng\nTiếng Việt có chùm phụ âm ngh, ba chữ, vẫn hợp lệ.',
    'Quần jean nam size 32\nHàng VNXK, còn mới 95%.',
  ]

  for (const text of REAL) {
    it(`tha: ${JSON.stringify(text.slice(0, 34))}`, () => {
      expect(looksMashed(text)).toBe(false)
    })
  }

  /**
   * Ranh giới của luật "token ngắn cần HAI cái mới kết luận".
   *
   * Một token 5–7 chữ dính dấu hiệu là chuyện thường ở tên riêng tiếng Anh; hai cái trong cùng
   * một tin thì không còn là tình cờ. Ghim cả hai phía để lần sau ai chỉnh ngưỡng còn biết
   * mình vừa đánh đổi cái gì.
   */
  it('MỘT token ngắn khả nghi thì tha, HAI thì bắt', () => {
    // "Sports" (0.167 nguyên âm) cố ý KHÔNG khả nghi — đó là lý do ngưỡng là 0.15, không phải 0.2.
    expect(looksMashed('Sports')).toBe(false)
    expect(looksMashed('Sprthn')).toBe(false)
    expect(looksMashed('Sprthn Nhgtrk')).toBe(true)
  })
})
