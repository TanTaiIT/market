import { describe, it, expect, vi } from 'vitest'

// Chạy với cloud name ĐÃ BIẾT — file `imageUrl.test.ts` là ca ngược lại (server chưa biết cloud).
vi.mock('../../src/config/env', () => ({ env: { CLOUDINARY_CLOUD_NAME: 'ghim-prod' } }))

import { cloudinaryImageUrl } from '../../src/common/utils/imageUrl'

const ok = (url: string) => cloudinaryImageUrl.safeParse(url).success

/**
 * Audit 1.16: host `res.cloudinary.com` là chung cho MỌI tài khoản Cloudinary — ai cũng đăng ký
 * được một cloud rồi trỏ ảnh của họ vào bảng tin. Biết cloud name thì phải chốt luôn cloud name.
 */
describe('URL ảnh — chốt cả cloud name khi server biết nó', () => {
  it('nhận ảnh của đúng cloud', () => {
    expect(ok('https://res.cloudinary.com/ghim-prod/image/upload/v1/ghim/a.webp')).toBe(true)
  })

  it('từ chối ảnh của cloud khác, dù host đúng', () => {
    expect(ok('https://res.cloudinary.com/demo/image/upload/v1/sample.jpg')).toBe(false)
    expect(ok('https://res.cloudinary.com/ghim-prod-fake/image/upload/v1/a.jpg')).toBe(false)
    expect(ok('https://res.cloudinary.com/x/ghim-prod/image/upload/v1/a.jpg')).toBe(false)
  })
})
