import { describe, it, expect } from 'vitest'
import {
  toOrgSlug,
  normalizeOrgSlug,
  isReservedSlug,
  suggestOrgSlugs,
  orgNameTokens,
} from '../../src/common/utils/orgSlug'

describe('orgSlug - chuẩn hoá', () => {
  it('fold dấu tiếng Việt', () => {
    expect(toOrgSlug('THPT Lý Thường Kiệt')).toBe('thpt-ly-thuong-kiet')
    expect(toOrgSlug('Trường Đại học Đà Nẵng')).toBe('truong-dai-hoc-da-nang')
  })

  it('gộp gạch liên tiếp và cắt gạch đầu/cuối', () => {
    expect(toOrgSlug('--ly--thuong---kiet--')).toBe('ly-thuong-kiet')
  })

  it('khoá so trùng coi ba biến thể là một', () => {
    const canonical = normalizeOrgSlug('ly-thuong-kiet')
    expect(normalizeOrgSlug('ly--thuong-kiet')).toBe(canonical)
    expect(normalizeOrgSlug('lythuongkiet')).toBe(canonical)
    expect(normalizeOrgSlug('Lý Thường Kiệt')).toBe(canonical)
  })

  it('ký tự Cyrillic nhìn giống Latin bị fold, không bị xoá âm thầm', () => {
    // "аdmin" với а Cyrillic (U+0430). Nếu chỉ xoá ký tự lạ thì nó thành "dmin" và lọt chốt.
    expect(toOrgSlug('аdmin')).toBe('admin')
    expect(isReservedSlug('аdmin')).toBe(true)
  })
})

describe('orgSlug - slug hệ thống', () => {
  it('chặn slug làm vỡ routing hoặc mạo danh trang hệ thống', () => {
    for (const slug of ['admin', 'api', 'login', 'settings', 'www', 'o', 'new', 'search']) {
      expect(isReservedSlug(slug)).toBe(true)
    }
  })

  it('chặn cả biến thể có gạch của slug hệ thống', () => {
    expect(isReservedSlug('ad-min')).toBe(true)
  })

  it('không chặn nhầm slug thường', () => {
    expect(isReservedSlug('thpt-ly-thuong-kiet')).toBe(false)
    expect(isReservedSlug('cua-hang-xyz')).toBe(false)
  })
})

describe('orgSlug - gợi ý khi trùng', () => {
  it('ưu tiên hậu tố có nghĩa (quận, tỉnh) trước khi đánh số', () => {
    const suggestions = suggestOrgSlugs('thcs-ly-thuong-kiet', {
      district: 'Quận Đống Đa',
      provinceCode: 'Hà Nội',
    })
    expect(suggestions[0]).toBe('thcs-ly-thuong-kiet-quan-dong-da')
    expect(suggestions[1]).toBe('thcs-ly-thuong-kiet-ha-noi')
    expect(suggestions).toContain('thcs-ly-thuong-kiet-2')
  })

  it('không có gợi ý địa bàn thì rơi về đánh số', () => {
    expect(suggestOrgSlugs('nhom-ban-than')).toEqual(['nhom-ban-than-2', 'nhom-ban-than-3'])
  })

  it('không sinh trùng nhau', () => {
    const suggestions = suggestOrgSlugs('abc', { district: null, provinceCode: null })
    expect(new Set(suggestions).size).toBe(suggestions.length)
  })
})

/**
 * `orgNameTokens` là khoá tra của dropdown chọn org. Nó thay cho regex không neo đầu trên
 * `name` — thứ khiến cả câu `$or` rơi về COLLSCAN vì `name` không có index.
 */
describe('orgNameTokens', () => {
  it('bỏ dấu và tách theo từ', () => {
    expect(orgNameTokens('Trường Hùng Vương')).toEqual(['truong', 'hung', 'vuong'])
  })

  it('gõ một từ giữa tên vẫn khớp được — chính là ca mà tiền tố cả chuỗi làm hỏng', () => {
    // "truonghungvuong".startsWith("hung") là false; token "hung" thì khớp.
    expect(orgNameTokens('Trường Hùng Vương')).toContain('hung')
  })

  it('gộp từ trùng, bỏ khoảng trắng thừa và ký tự lạ', () => {
    expect(orgNameTokens('Cửa  hàng   XYZ!!! hàng')).toEqual(['cua', 'hang', 'xyz'])
  })

  it('chuỗi rỗng hoặc toàn ký tự lạ ra mảng rỗng — caller phải chịu được, không phải `$or: []`', () => {
    expect(orgNameTokens('')).toEqual([])
    expect(orgNameTokens('!!! ???')).toEqual([])
  })

  it('fold ký tự nhìn giống Latin, cùng luật với slug', () => {
    // "аbc" viết bằng а Cyrillic phải ra cùng token với "abc", nếu không thì tra không ra.
    expect(orgNameTokens('аbc edu')).toEqual(['abc', 'edu'])
  })
})
