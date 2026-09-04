/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
import { Listing } from '../src/features/listing/listing.model'
import {
  listingExpiresAt,
  listingExpiryService,
} from '../src/features/listing/listing.expiry.service'
import { runUnscoped } from '../src/common/tenant/tenantContext'

/**
 * Chuyển hết-hạn từ "Mongo xoá thật" sang "job hạ trạng thái".
 *
 * BẮT BUỘC chạy trên production, và chạy được CÀNG SỚM CÀNG TỐT (trước hoặc ngay sau khi
 * deploy): `autoIndex` tắt ở production (`config/database.ts`), nên `syncIndexes` ở đây là
 * nơi DUY NHẤT vừa gỡ TTL index cũ vừa tạo index `{status, expiresAt}` mà job cần. Chưa chạy
 * thì Mongo vẫn xoá thật tin tới hạn và job mới không bao giờ kịp thấy chúng.
 *
 * CHẠY TỪ MÁY DEV / CI, KHÔNG từ container đang deploy: image chỉ có `dist/` + dependency
 * production, không có `scripts/` lẫn `tsx`. Lệnh cho từng môi trường:
 *
 *   npm run migrate:listing-expiry        # NODE_ENV=development -> .env.development -> market-dev
 *   npm run migrate:listing-expiry:prod   # NODE_ENV=production  -> .env.production  -> market-pro
 *
 * Ba bước, đúng thứ tự này: gỡ index (ngừng chảy máu) → backfill tin thiếu hạn → quét lượt
 * đầu. Đảo bước 1 xuống sau là để Mongo xoá thêm một nhịp nữa. Idempotent — chạy lại chỉ đụng
 * tin còn thiếu hạn.
 */
async function migrate() {
  await mongoose.connect(env.MONGO_URI)

  /*
   * In TÊN DB trước khi ghi, không phải "connected" suông — cùng lý do `connectDB` làm vậy:
   * dev và production dùng chung một cluster, chỉ khác tên db, nên đây là chỗ duy nhất xác
   * nhận được mình đang gỡ index của đúng nơi mình nghĩ.
   */
  console.log(`▶ db "${mongoose.connection.name}" · NODE_ENV=${env.NODE_ENV}`)

  const dropped = await Listing.syncIndexes()

  /*
   * Tin thiếu `expiresAt` là tin có TRƯỚC ngày thêm hạn — chúng sống sót đúng vì TTL index bỏ
   * qua document không có field. Đặt hạn từ BÂY GIỜ (+30 ngày), không phải `createdAt + 30`:
   * lấy mốc `createdAt` là ẩn sạch tin cũ ngay giây deploy, người bán chưa từng được báo là
   * tin có hạn mà đã mất tin. Cho họ trọn một vòng 30 ngày để kịp gia hạn.
   *
   * `updateMany` (không hook soft-delete) để tin xoá mềm cũng có hạn — kẻo khôi phục ở tương
   * lai lại ra một tin bất tử.
   */
  const filled = await runUnscoped('migration: backfill expiresAt cho tin cũ', () =>
    Listing.updateMany({ expiresAt: null }, { $set: { expiresAt: listingExpiresAt() } }).exec(),
  )

  const expired = await listingExpiryService.sweep()

  console.log(
    `Index đã đồng bộ` +
      (dropped.length ? `, gỡ ${dropped.length} index cũ: ${dropped.join(', ')}` : '') +
      `. Backfill hạn cho ${filled.modifiedCount} tin cũ. Lượt quét đầu hạ ${expired} tin quá hạn.`,
  )

  await mongoose.disconnect()
  process.exit(0)
}

migrate().catch((err) => {
  console.error(err)
  process.exit(1)
})
