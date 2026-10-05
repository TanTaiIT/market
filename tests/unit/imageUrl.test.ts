import { describe, it, expect } from 'vitest'
import { cloudinaryImageUrl, userAvatarUrl } from '../../src/common/utils/imageUrl'

const ok = (url: string) => cloudinaryImageUrl.safeParse(url).success
const okAvatar = (url: string) => userAvatarUrl.safeParse(url).success

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

/**
 * Avatar tài khoản nới thêm ĐÚNG MỘT nguồn so với ảnh bảng tin, và nhóm ca dưới neo cả hai vế
 * của quyết định đó: vì sao phải nới (người đăng nhập bằng Google mang sẵn avatar của Google,
 * chặn là họ không lưu nổi hồ sơ) và nới tới đâu thì dừng.
 */
describe('URL avatar tài khoản — Cloudinary hoặc ảnh Google', () => {
  it('nhận Cloudinary như mọi ảnh khác', () => {
    expect(okAvatar('https://res.cloudinary.com/demo/image/upload/v1/ghim/me.jpg')).toBe(true)
  })

  it('nhận ảnh Google — đây là avatar hệ thống tự gán lúc đăng nhập Google', () => {
    expect(okAvatar('https://lh3.googleusercontent.com/a/ACg8ocK=s96-c')).toBe(true)
    // Google đã dùng lh4/lh5/lh6 ở các thời kỳ khác nhau, nên luật chốt theo hậu tố.
    expect(okAvatar('https://lh6.googleusercontent.com/a/abc=s96-c')).toBe(true)
  })

  it('vẫn từ chối host bất kỳ — đây là lỗ hổng vừa bịt, trước đó avatar nhận MỌI URL', () => {
    expect(okAvatar('https://example.com/pixel.gif')).toBe(false)
    expect(okAvatar('https://tracker.evil.tld/a.png')).toBe(false)
  })

  it('từ chối host chỉ GIỐNG CDN của Google', () => {
    expect(okAvatar('https://evil-googleusercontent.com/a.jpg')).toBe(false)
    expect(okAvatar('https://googleusercontent.com.evil.tld/a.jpg')).toBe(false)
  })
})
