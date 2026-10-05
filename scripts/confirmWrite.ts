/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'

/** `-- --dry-run`: chỉ đọc và đếm, không ghi một byte. Script nào nhận cờ này phải tự rẽ nhánh. */
export const DRY_RUN = process.argv.includes('--dry-run')

/** Biến phải gõ TƯỜNG MINH trên dòng lệnh khi ghi vào production — không đặt vào `.env*`. */
const CONFIRM = 'CONFIRM_DB'

/**
 * Chốt cho migration GHI vào production. Gọi SAU `mongoose.connect` và TRƯỚC lượt ghi đầu tiên.
 *
 * Khác `assertDisposableDb` (chốt cho script XOÁ SẠCH, cấm cứng db thật): migration thì phải
 * chạy được vào `market-pro`, nên chốt ở đây là bắt người gõ lệnh NÓI RA tên db mình định ghi —
 * `CONFIRM_DB=market-pro npm run migrate:x:prod`. Gõ nhầm alias `:prod` mà không có biến đó thì
 * dừng ngay tại đây: đã đếm xong, chưa ghi gì. `--dry-run` luôn qua.
 */
export function assertWriteConfirmed(scriptName: string): void {
  if (DRY_RUN) {
    console.log(`[${scriptName}] DRY RUN — chỉ đếm, không ghi.`)
    return
  }
  if (!env.isProd) return

  const dbName = mongoose.connection.name
  if (process.env[CONFIRM] === dbName) return

  throw new Error(
    `${scriptName} từ chối ghi vào "${dbName}" (NODE_ENV=production) khi chưa xác nhận.\n` +
      `Chạy thử trước: npm run <lệnh> -- --dry-run\n` +
      `Chạy thật:      ${CONFIRM}=${dbName} npm run <lệnh>`,
  )
}
