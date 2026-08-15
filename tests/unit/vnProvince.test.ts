import { describe, it, expect } from 'vitest'
import { VN_PROVINCE_NAMES } from '../../src/common/constants'
import { createListingSchema, listingQuerySchema } from '../../src/features/listing/listing.schema'

const baseListing = {
  title: 'Xe đạp thể thao cũ',
  description: 'Còn dùng tốt, đã đi được hai năm.',
  price: 1500000,
  categoryId: '6a7dd90eeff1d27bcbfa0e9f',
  images: ['https://example.com/a.jpg'],
}

describe('danh sách tỉnh/thành', () => {
  it('đúng 34 đơn vị sau sáp nhập 01/07/2025', () => {
    expect(VN_PROVINCE_NAMES).toHaveLength(34)
  })

  it('không còn tên tỉnh đã bị sáp nhập', () => {
    for (const gone of ['Bình Dương', 'Hà Giang', 'Quảng Nam', 'Bà Rịa - Vũng Tàu']) {
      expect(VN_PROVINCE_NAMES).not.toContain(gone)
    }
  })
})

describe('createListing — location.province', () => {
  it('nhận tên trong danh sách', () => {
    const parsed = createListingSchema.safeParse({
      ...baseListing,
      location: { province: 'Hồ Chí Minh' },
    })
    expect(parsed.success).toBe(true)
  })

  it('từ chối biến thể có tiền tố — đây là ca gây lọc rỗng im lặng trước đây', () => {
    const parsed = createListingSchema.safeParse({
      ...baseListing,
      location: { province: 'TP. Hồ Chí Minh' },
    })
    expect(parsed.success).toBe(false)
  })

  it('từ chối tỉnh đã bị sáp nhập', () => {
    const parsed = createListingSchema.safeParse({
      ...baseListing,
      location: { province: 'Bình Dương' },
    })
    expect(parsed.success).toBe(false)
  })
})

describe('listingQuery — bộ lọc province', () => {
  it('tên sai giờ là 400 thay vì trả về danh sách rỗng', () => {
    expect(listingQuerySchema.safeParse({ province: 'Sài Gòn' }).success).toBe(false)
  })

  it('bỏ trống vẫn hợp lệ — không lọc theo tỉnh', () => {
    expect(listingQuerySchema.safeParse({}).success).toBe(true)
  })
})
