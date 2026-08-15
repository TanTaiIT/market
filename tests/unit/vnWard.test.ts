import { describe, it, expect } from 'vitest'
import { VN_PROVINCES, wardsOf, isWardOfProvince } from '../../src/common/constants'
import { createListingSchema, nearbyQuerySchema } from '../../src/features/listing/listing.schema'

const baseListing = {
  title: 'Xe đạp thể thao cũ',
  description: 'Còn dùng tốt, đã đi được hai năm.',
  price: 1500000,
  categoryId: '6a7dd90eeff1d27bcbfa0e9f',
  images: ['https://example.com/a.jpg'],
}

describe('bảng phường/xã', () => {
  it('đủ 3.321 đơn vị cấp xã', () => {
    const total = VN_PROVINCES.reduce((sum, p) => sum + wardsOf(p.name).length, 0)
    expect(total).toBe(3321)
  })

  it('không tỉnh nào bị rỗng — hụt một tỉnh là ô chọn xã trắng trơn', () => {
    const empty = VN_PROVINCES.filter((p) => wardsOf(p.name).length === 0).map((p) => p.name)
    expect(empty).toEqual([])
  })

  it('xã sau sáp nhập nằm đúng tỉnh mới', () => {
    // Vũng Tàu và Thủ Dầu Một giờ thuộc TP.HCM — đây là ca dễ sai nhất nếu lấy nhầm dữ liệu cũ.
    expect(isWardOfProvince('Hồ Chí Minh', 'Phường Vũng Tàu')).toBe(true)
    expect(isWardOfProvince('Hồ Chí Minh', 'Phường Thủ Dầu Một')).toBe(true)
    expect(isWardOfProvince('Hà Nội', 'Phường Vũng Tàu')).toBe(false)
  })
})

describe('createListing — location không còn toạ độ', () => {
  it('nhận tỉnh + xã, không cần coordinates', () => {
    const parsed = createListingSchema.safeParse({
      ...baseListing,
      location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
    })
    expect(parsed.success).toBe(true)
  })

  it('từ chối coordinates — field đã bị bỏ, `.strict()` phải chặn để client cũ biết mà sửa', () => {
    const parsed = createListingSchema.safeParse({
      ...baseListing,
      location: { province: 'Hồ Chí Minh', coordinates: [106.7, 10.77] },
    })
    expect(parsed.success).toBe(false)
  })

  it('bỏ trống location vẫn hợp lệ', () => {
    expect(createListingSchema.safeParse(baseListing).success).toBe(true)
  })

  it('từ chối xã không thuộc tỉnh đã chọn', () => {
    const parsed = createListingSchema.safeParse({
      ...baseListing,
      location: { province: 'Hà Nội', ward: 'Phường Vũng Tàu' },
    })
    expect(parsed.success).toBe(false)
  })

  it('chỉ có tỉnh, không có xã vẫn hợp lệ — ràng buộc cặp chỉ áp khi có cả hai', () => {
    const parsed = createListingSchema.safeParse({
      ...baseListing,
      location: { province: 'Hà Nội' },
    })
    expect(parsed.success).toBe(true)
  })
})

describe('nearby — theo địa giới, không theo bán kính', () => {
  it('cần province', () => {
    expect(nearbyQuerySchema.safeParse({}).success).toBe(false)
    expect(nearbyQuerySchema.safeParse({ province: 'Hồ Chí Minh' }).success).toBe(true)
  })

  it('ward và exclude là tuỳ chọn', () => {
    const parsed = nearbyQuerySchema.safeParse({
      province: 'Hồ Chí Minh',
      ward: 'Phường Bến Thành',
      exclude: '6a7dd90eeff1d27bcbfa0e9f',
    })
    expect(parsed.success).toBe(true)
  })

  it('không còn nhận lng/lat', () => {
    expect(nearbyQuerySchema.safeParse({ lng: 106.7, lat: 10.77 }).success).toBe(false)
  })
})
