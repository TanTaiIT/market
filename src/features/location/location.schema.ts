import { z } from 'zod'
import { registry } from '../../config/openapi'
import { VN_PROVINCE_NAMES } from '../../common/constants'

/**
 * Từ điển địa giới hành chính 2 cấp (Tỉnh → Phường/Xã) sau 01/07/2025. Dữ liệu tĩnh, không
 * thuộc organization nào và không đụng Mongo — feature này vì thế không có model/repository.
 */

export const wardQuerySchema = z.object({
  province: z.enum(VN_PROVINCE_NAMES).openapi({ example: 'Hồ Chí Minh' }),
})

export const provinceResponseSchema = z
  .object({
    name: z.enum(VN_PROVINCE_NAMES).openapi({ description: 'Giá trị lưu vào location.province' }),
    fullName: z.string().openapi({ description: 'Tên đầy đủ theo văn bản hành chính' }),
    formerNames: z.array(z.string()).openapi({
      description: 'Tỉnh cũ đã nhập vào đơn vị này từ 01/07/2025 — hợp lệ để hiển thị',
    }),
    aliases: z
      .array(z.string())
      .openapi({ description: 'Gọi tắt / tên thành phố quen thuộc — chỉ dùng để dò tìm' }),
  })
  .openapi('Province')

export const wardListResponseSchema = z
  .object({
    province: z.enum(VN_PROVINCE_NAMES),
    wards: z.array(z.string()),
  })
  .openapi('WardList')

export type WardQuery = z.infer<typeof wardQuerySchema>

registry.register('Province', provinceResponseSchema)
registry.register('WardList', wardListResponseSchema)
