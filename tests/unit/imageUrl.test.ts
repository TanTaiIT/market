import { describe, it, expect } from 'vitest'
import { cloudinaryImageUrl } from '../../src/common/utils/imageUrl'

const ok = (url: string) => cloudinaryImageUrl.safeParse(url).success

/**
 * Luật này là lớp chặn duy nhất giữa "ảnh người bán tự host" và bảng tin: ảnh ở host lạ đổi
 * được RUỘT sau khi tin đã qua đủ bốn lớp duyệt, và mỗi lượt xem tin là một request về máy chủ
 * của họ. Nới một dòng ở đây là mở lại cả ba hệ quả đó.
 */
describe('URL ảnh — chỉ nhận Cloudinary', () => {
  it('nhận đường dẫn Cloudinary hợp lệ', () => {
    expect(ok('https://res.cloudinary.com/demo/image/upload/v1/sample.jpg')).toBe(true)
    expect(ok('https://res.cloudinary.com/ds4dqc7s5/image/upload/v1724/ghim/abc.webp')).toBe(true)
  })

  it('từ chối host lạ, dù URL hợp lệ về hình thức', () => {
    expect(ok('https://example.com/a.jpg')).toBe(false)
    expect(ok('https://picsum.photos/seed/x/800/600')).toBe(false)
  })

  it('từ chối host chỉ GIỐNG Cloudinary — đây là ca lách kinh điển', () => {
    expect(ok('https://res.cloudinary.com.evil.tld/a.jpg')).toBe(false)
    expect(ok('https://evil.tld/res.cloudinary.com/a.jpg')).toBe(false)
    expect(ok('https://notres.cloudinary.com/a.jpg')).toBe(false)
  })

  it('từ chối chuỗi không phải URL', () => {
    expect(ok('res.cloudinary.com/a.jpg')).toBe(false)
    expect(ok('')).toBe(false)
  })
})
