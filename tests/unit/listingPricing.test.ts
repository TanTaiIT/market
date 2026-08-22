import { describe, it, expect } from 'vitest'
import { PRICING, postingFee } from '../../src/features/listing/listing.pricing'

describe('Luật phí đăng tin — giai đoạn miễn phí', () => {
  /**
   * Test CANARY — cố ý gãy khi ai đó đổi `POST_FEE`.
   *
   * Bật phí là quyết định kinh doanh có checklist riêng (xu-wallet.decision.md §5), không
   * phải một con số sửa tiện tay. Đổi giá thì PHẢI sửa test này trong cùng lượt commit —
   * đó chính là bằng chứng việc đổi là có ý thức.
   */
  it('phí đang là 0 — đổi số này đọc xu-wallet.decision.md trước', () => {
    expect(PRICING.POST_FEE).toBe(0)
  })

  it('mọi hồ sơ người đăng đều nhận cùng một giá ở giai đoạn miễn phí', () => {
    expect(postingFee({ trustLevel: 0 })).toEqual({ amount: 0, currency: 'xu' })
    expect(postingFee({ trustLevel: 2, categoryId: '65f000000000000000000001' })).toEqual({
      amount: 0,
      currency: 'xu',
    })
  })
})
