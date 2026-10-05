import { Query, Schema } from 'mongoose'

/**
 * Soft delete dùng chung (audit 5.10): mọi lượt đọc mặc định loại bản ghi có `deletedAt`; query
 * đặt `withDeleted: true` mới thấy lại. Trước đây bảy model chép cùng một hook — sửa một chỗ quên
 * sáu chỗ, và `Organization` từng thiếu hẳn (audit 5.6).
 *
 * `countDocuments` đăng ký riêng: regex `/^find/` không khớp nó, và đó là đúng lỗ đã gây bug
 * đếm sai trước đây.
 */
function excludeDeleted(this: Query<unknown, unknown>, next: () => void) {
  if (!this.getOptions().withDeleted) {
    this.where({ deletedAt: null })
  }
  next()
}

export function softDeletePlugin(schema: Schema): void {
  schema.pre(/^find/, excludeDeleted)
  schema.pre('countDocuments', excludeDeleted)
}
