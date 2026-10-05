import { z } from 'zod'

/**
 * Chuỗi ObjectId hợp lệ — MỘT định nghĩa cho mọi schema (audit 5.10): trước đây 20 file schema
 * chép cùng một regex, và thông điệp lỗi/format có ngày lệch nhau mà không ai để ý.
 */
export const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')
