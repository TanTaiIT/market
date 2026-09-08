import winston from 'winston'
import { env } from './env'
import { removeEmoji } from '../common/utils/removeEmoji'
import { currentRequestContext } from '../common/observability/requestContext'

/**
 * message/stack của Error là non-enumerable -> JSON.stringify trả "{}" và nuốt sạch lỗi.
 *
 * Tách thành hàm riêng vì CẢ HAI format đều cần: nhánh JSON của production đi qua
 * `winston.format.json`, và nếu không truyền replacer vào đó thì mọi `logger.error(msg, { err })`
 * ở production mất trắng stack — đúng loại log duy nhất mà stack là thứ cần nhất.
 */
function errorReplacer(_key: string, value: unknown) {
  return value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack }
    : value
}

function serializeMeta(meta: Record<string, unknown>): string {
  if (!Object.keys(meta).length) return ''
  return ` ${JSON.stringify(meta, errorReplacer)}`
}

const { combine, timestamp, printf, json } = winston.format

/**
 * Gắn `requestId`/`userId`/`orgSlug` vào MỌI dòng log, lấy từ AsyncLocalStorage.
 *
 * Ở đây chứ không ở từng call-site: có ~200 lời gọi `logger.*` rải khắp service và
 * repository, bắt mỗi chỗ tự truyền ngữ cảnh là 200 chỗ có thể quên — mà dòng bị quên lại
 * chính là dòng cần nhất lúc điều tra. Job nền không có ngữ cảnh nào thì bỏ trống, không bịa.
 */
const withContext = winston.format((info) => {
  const ctx = currentRequestContext()
  if (ctx) {
    info.requestId = ctx.requestId
    if (ctx.userId) info.userId = ctx.userId
    if (ctx.orgSlug) info.orgSlug = ctx.orgSlug
  }
  return info
})

const consoleFormat = printf((info) => {
  const { level, message, timestamp: ts, requestId, ...meta } = info
  delete meta.service // đã có trong defaultMeta, in lại mỗi dòng chỉ tổ nhiễu
  // 8 ký tự đầu của uuid là đủ để mắt người nối các dòng của cùng một request khi đọc trực
  // tiếp; bản đầy đủ vẫn nằm trong log JSON của production.
  const tag = typeof requestId === 'string' ? ` [${requestId.slice(0, 8)}]` : ''
  return `${ts}${tag} ${level}: ${removeEmoji(message)}${serializeMeta(meta)}`
})

export const logger = winston.createLogger({
  level: env.isProd ? 'info' : 'debug',
  defaultMeta: { service: 'cho-tot-clone-api' },
  transports: [
    new winston.transports.Console({
      /*
       * Hai format cho hai người đọc khác nhau, KHÔNG phải một format dung hoà.
       *
       * Prod: JSON + timestamp ISO đầy đủ. Mọi hệ thu log tách được field nên lọc theo
       * `requestId`/`userId` là một câu truy vấn, không phải một biểu thức regex. Và
       * timestamp phải có NGÀY — bản trước chỉ có `HH:mm:ss`, nên log ba ngày trộn vào nhau
       * là không phân biệt nổi, đúng lúc cần dựng lại trình tự một sự cố.
       *
       * Dev: một dòng ngắn cho mắt người, giờ không cần ngày vì đang xem trực tiếp.
       */
      format: env.isProd
        ? combine(withContext(), timestamp(), json({ replacer: errorReplacer }))
        : combine(withContext(), timestamp({ format: 'HH:mm:ss' }), consoleFormat),
      stderrLevels: ['error'],
    }),
  ],
})
