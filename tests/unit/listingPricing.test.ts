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

describe('Catalog gói tin — giai đoạn chưa mở bán', () => {
  it('CANARY: mọi gói đang tắt và chưa có giá — mở bán đọc xu-wallet.decision.md §6 trước', async () => {
    const { LISTING_PRODUCTS } = await import('../../src/features/listing/listing.pricing')
    for (const product of LISTING_PRODUCTS) {
      expect(product.enabled).toBe(false)
      expect(product.price).toBeNull()
    }
  })

  it('mã gói không trùng nhau, và gói theo thời hạn phải khai số ngày', async () => {
    const { LISTING_PRODUCTS } = await import('../../src/features/listing/listing.pricing')
    const codes = LISTING_PRODUCTS.map((p) => p.code)
    expect(new Set(codes).size).toBe(codes.length)

    for (const product of LISTING_PRODUCTS) {
      if (product.effect === 'featured' || product.effect === 'extend_expiry') {
        expect(product.durationDays).toBeGreaterThan(0)
      }
    }
  })
})
