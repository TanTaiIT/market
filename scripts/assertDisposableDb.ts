/* eslint-disable no-console */
import { env } from '../src/config/env'

/** Ép chạy dù chốt không thông — phải gõ tường minh trên dòng lệnh, không đặt vào `.env`. */
const OVERRIDE = 'SEED_ALLOW_REMOTE'

/**
 * Host được coi là "DB dùng một lần": mongo trên máy này, hoặc service `mongo` của
 * docker-compose. Mọi host khác là DB có người khác đang dùng chung.
 */
const DISPOSABLE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'mongo'])

function hostOf(uri: string): string | null {
  try {
    return new URL(uri).hostname
  } catch {
    // URI nhiều host (`mongodb://h1:27017,h2:27017/db`) không parse được -> coi như KHÔNG an
    // toàn. Chốt an toàn phải fail-closed: không đọc nổi thì từ chối, đừng đoán.
    return null
  }
}

/**
 * Chốt cuối trước khi một script gọi `deleteMany({})` trên toàn bộ collection.
 *
 * Dev và production đang dùng CHUNG một file `.env`, nên lúc gõ `npm run seed` thì
 * `env.MONGO_URI` có thể đang trỏ thẳng vào cluster thật mà người gõ không nhận ra — mất
 * dữ liệu mà không có bước xác nhận nào.
 *
 * Không kiểm `NODE_ENV` là đủ: file `.env` để `NODE_ENV=development` ngay cả khi URI là
 * Atlas, nên chính HOST của URI mới là dấu hiệu đáng tin.
 */
export function assertDisposableDb(scriptName: string): void {
  const host = hostOf(env.MONGO_URI)
  const risks: string[] = []

  if (env.isProd) risks.push('NODE_ENV=production')
  if (host === null) risks.push('MONGO_URI nhiều host, không xác định được là local hay không')
  else if (!DISPOSABLE_HOSTS.has(host)) risks.push(`MONGO_URI trỏ host từ xa (${host})`)

  if (risks.length === 0) return

  if (process.env[OVERRIDE] === 'yes') {
    console.warn(`[${scriptName}] BỎ QUA chốt an toàn (${OVERRIDE}=yes): ${risks.join(' · ')}`)
    console.warn(`[${scriptName}] Sắp XOÁ SẠCH mọi collection trên DB này.`)
    return
  }

  throw new Error(
    `${scriptName} từ chối chạy vì ${risks.join(' · ')}.\n` +
      `Script này xoá sạch mọi collection trước khi seed.\n` +
      `Trỏ MONGO_URI về mongo local rồi chạy lại, hoặc ép chạy: ${OVERRIDE}=yes npm run <lệnh>`,
  )
}
