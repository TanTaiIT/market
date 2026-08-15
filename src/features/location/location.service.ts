import { VN_PROVINCES, wardsOf } from '../../common/constants'
import { WardQuery } from './location.schema'

/**
 * Đọc thuần từ hằng số trong `common/constants` — không cache, không I/O. Bảng 34 tỉnh và
 * 3.321 xã nằm sẵn trong bộ nhớ tiến trình nên thêm một lớp cache ở đây chỉ tốn chỗ.
 */
export const locationService = {
  listProvinces() {
    return VN_PROVINCES.map((p) => ({
      name: p.name,
      fullName: p.fullName,
      formerNames: [...p.formerNames],
      aliases: [...p.aliases],
    }))
  },

  listWards({ province }: WardQuery) {
    return { province, wards: [...wardsOf(province)] }
  },
}
