/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
import { Listing } from '../src/features/listing/listing.model'
import { runUnscoped } from '../src/common/tenant/tenantContext'

/**
 * Backfill `rankAt = createdAt` cho tin có trước ngày thêm khoá sắp xếp, rồi đồng bộ index
 * (họ index bảng tin đổi đuôi `createdAt` → `rankAt`, xem listing.model.ts).
 *
 * BẮT BUỘC chạy ngay sau khi deploy bản có `rankAt`: BSON xếp field vắng mặt nhỏ hơn mọi
 * Date, nên tin cũ chưa backfill sẽ chìm xuống đáy mọi bảng tin. Idempotent — chạy lại chỉ
 * đụng tin còn thiếu field.
 */
async function migrate() {
  await mongoose.connect(env.MONGO_URI)

  // Filter `rankAt: null` match cả field vắng mặt; update dạng pipeline để copy được giá trị
  // của chính document. Cố ý dùng updateMany (không dính hook find của soft-delete): tin xoá
  // mềm cũng cần backfill, kẻo ai đó khôi phục ở tương lai lại ra một tin không có khoá sort.
  const res = await runUnscoped('migration: backfill rankAt = createdAt', () =>
    Listing.updateMany({ rankAt: null }, [{ $set: { rankAt: '$createdAt' } }]).exec(),
  )

  const dropped = await Listing.syncIndexes()
  console.log(
    `Backfilled ${res.modifiedCount} tin. Index đã đồng bộ` +
      (dropped.length
        ? `, gỡ ${dropped.length} index cũ: ${dropped.join(', ')}`
        : ', không có index thừa.'),
  )

  await mongoose.disconnect()
  process.exit(0)
}

migrate().catch((err) => {
  console.error(err)
  process.exit(1)
})
