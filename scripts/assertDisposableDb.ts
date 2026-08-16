/* eslint-disable no-console */
import { env } from '../src/config/env'

/** Ép chạy dù chốt không thông — phải gõ tường minh trên dòng lệnh, không đặt vào `.env`. */
const OVERRIDE = 'SEED_ALLOW_REMOTE'

/**
 * Host được coi là "DB dùng một lần": mongo trên máy này, hoặc service `mongo` của
 * docker-compose. Mọi host khác là DB có người khác đang dùng chung.
 */
const DISPOSABLE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'mongo'])

/**
 * Database dành riêng cho develop: được phép xoá sạch dù nằm trên cluster từ xa. Có danh sách
 * này thì `npm run seed` chạy thẳng vào `market-dev` mà không cần override — quan trọng, vì
 * bắt người ta gõ `SEED_ALLOW_REMOTE=yes` mỗi ngày là dạy họ gõ nó cả lúc đang trỏ nhầm.
 */
const DISPOSABLE_DB_NAMES = new Set(['market-dev'])

/**
 * Database giữ dữ liệu thật. Chốt CỨNG: không override nào mở được — muốn seed vào đây thì
 * phải sửa chính file này, tức là một thay đổi có người review, không phải một biến gõ vội.
 * `market` là db cũ trước khi tách dev/pro, vẫn đang giữ dữ liệu.
 */
const PROTECTED_DB_NAMES = new Set(['market-pro', 'market'])

function hostOf(uri: string): string | null {
  try {
    return new URL(uri).hostname
  } catch {
    // URI nhiều host (`mongodb://h1:27017,h2:27017/db`) không parse được -> coi như KHÔNG an
    // toàn. Chốt an toàn phải fail-closed: không đọc nổi thì từ chối, đừng đoán.
    return null
  }
}

/** Tên db trong URI (`…/market-dev?retryWrites=true` -> `market-dev`), null nếu không đọc được. */
function dbNameOf(uri: string): string | null {
  try {
    const name = new URL(uri).pathname.replace(/^\//, '')
    return name === '' ? null : decodeURIComponent(name)
  } catch {
    return null
  }
}

/**
 * Chốt cuối trước khi một script gọi `deleteMany({})` trên toàn bộ collection.
 *
 * `market-dev` và `market-pro` nằm trên CÙNG một cluster, chỉ khác tên db — nên lúc gõ
 * `npm run seed` thì `env.MONGO_URI` có thể đang trỏ vào db thật mà người gõ không nhận ra:
 * mất dữ liệu mà không có bước xác nhận nào.
 *
 * Không kiểm `NODE_ENV` là đủ: một file `.env.*` cũ vẫn để `NODE_ENV=development` trong khi
 * URI là Atlas, nên HOST và TÊN DB của URI mới là dấu hiệu đáng tin.
 */
export function assertDisposableDb(scriptName: string): void {
  const host = hostOf(env.MONGO_URI)
  const dbName = dbNameOf(env.MONGO_URI)

  if (dbName !== null && PROTECTED_DB_NAMES.has(dbName)) {
    throw new Error(
      `${scriptName} từ chối chạy: MONGO_URI trỏ database giữ dữ liệu thật ("${dbName}").\n` +
        `Script này xoá sạch mọi collection trước khi ghi.\n` +
        `${OVERRIDE} KHÔNG mở được chốt này — đổi MONGO_URI sang db develop rồi chạy lại.`,
    )
  }

  const risks: string[] = []
  const isDisposableDb = dbName !== null && DISPOSABLE_DB_NAMES.has(dbName)

  if (env.isProd) risks.push('NODE_ENV=production')
  if (host === null) risks.push('MONGO_URI nhiều host, không xác định được là local hay không')
  else if (!DISPOSABLE_HOSTS.has(host) && !isDisposableDb) {
    risks.push(
      `MONGO_URI trỏ host từ xa (${host}) và db "${dbName ?? '(không có tên)'}" không nằm trong danh sách dùng-một-lần`,
    )
  }

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
