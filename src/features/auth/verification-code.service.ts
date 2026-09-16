import { randomBytes, randomInt } from 'node:crypto'
import { hash, verify } from '@node-rs/bcrypt'
import { Types } from 'mongoose'
import {
  CODE_TTL_MS,
  type CodePurpose,
  EmailVerification,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
} from './email-verification.model'
import { BadRequestError, TooManyRequestsError } from '../../common/errors'

/**
 * Phát và kiểm mã 6 số — phần dùng CHUNG của xác thực email và đặt lại mật khẩu.
 *
 * Tách ra vì hai luồng chỉ khác nhau ở phần nghiệp vụ hai đầu (ai được xin mã, mã đúng thì làm
 * gì), còn ở giữa thì giống đến từng luật. Để mỗi luồng tự viết là hai bản sao của cùng bộ
 * chốt, rồi một bên siết mà bên kia quên.
 *
 * Tầng này KHÔNG gửi thư và KHÔNG biết người dùng là ai ngoài `userId`: quyết định gửi cho địa
 * chỉ nào là của người gọi, vì chính chỗ đó mới biết luồng này có được phép lộ ra là tài khoản
 * có tồn tại hay không.
 *
 * Bcrypt rounds cố ý thấp hơn mật khẩu (xem `BCRYPT_ROUNDS` của `user.model`): mã sống 10 phút
 * và chỉ có 5 lượt đoán, nên chi phí mỗi lượt kiểm không cần bằng một mật khẩu sống nhiều năm.
 */
const CODE_ROUNDS = 8

/** 6 chữ số từ CSPRNG. `Math.random` đoán được từ các giá trị trước — không dùng ở đây. */
function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export interface IssuedCode {
  code: string
  expiresInSeconds: number
  resendAfterSeconds: number
}

/**
 * Phát mã mới cho một cặp (người, cửa), GHI ĐÈ mã cũ của đúng cặp đó.
 *
 * Trả mã về dạng thô cho người gọi gửi đi — và đó là lý do hàm này không tự gửi: người gọi
 * phải quyết định gửi tới đâu, rồi tự dọn nếu gửi hỏng.
 */
export async function issueCode(userId: Types.ObjectId, purpose: CodePurpose): Promise<IssuedCode> {
  const existing = await EmailVerification.findOne({ userId, purpose }).exec()
  if (existing) {
    const waited = Date.now() - existing.sentAt.getTime()
    if (waited < RESEND_COOLDOWN_MS) {
      throw new TooManyRequestsError(
        `Vui lòng chờ ${Math.ceil((RESEND_COOLDOWN_MS - waited) / 1000)} giây rồi gửi lại`,
      )
    }
  }

  const code = newCode()
  const now = new Date()
  await EmailVerification.findOneAndUpdate(
    { userId, purpose },
    {
      codeHash: await hash(code, CODE_ROUNDS),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      attempts: 0,
      sentAt: now,
    },
    { upsert: true, new: true },
  ).exec()

  return {
    code,
    expiresInSeconds: Math.floor(CODE_TTL_MS / 1000),
    resendAfterSeconds: Math.floor(RESEND_COOLDOWN_MS / 1000),
  }
}

/**
 * Phát một VÉ — chuỗi ngẫu nhiên dài, đổi được từ một mã vừa nhập đúng.
 *
 * Khác `issueCode` ở hai chỗ, và cả hai đều có lý do:
 *
 * 1. **Không có hạn chờ.** Vé được phát ngay sau khi người dùng gõ đúng mã, nên một chốt "chờ
 *    60 giây" ở đây sẽ chặn đúng người vừa chứng minh mình là chủ.
 * 2. **Không phải 6 số.** Vé không ai gõ tay, nên nó dài để không đoán được — `MAX_ATTEMPTS`
 *    trở nên thừa với nó, và đó là chủ ý chứ không phải sơ hở.
 *
 * Đồng hồ 10 phút chạy lại từ đầu: người dùng vừa mất một phần thời gian để mở hộp thư, phần
 * còn lại phải đủ để họ nghĩ ra một mật khẩu.
 */
export async function issueTicket(userId: Types.ObjectId, purpose: CodePurpose): Promise<string> {
  const ticket = randomBytes(32).toString('hex')
  const now = new Date()

  await EmailVerification.findOneAndUpdate(
    { userId, purpose },
    {
      codeHash: await hash(ticket, CODE_ROUNDS),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      attempts: 0,
      sentAt: now,
    },
    { upsert: true, new: true },
  ).exec()

  return ticket
}

/** Gọi khi gửi thư hỏng: mã chưa từng tới tay ai thì đừng bắt họ chờ hết hạn chờ của nó. */
export function dropCode(userId: Types.ObjectId, purpose: CodePurpose): Promise<unknown> {
  return EmailVerification.deleteOne({ userId, purpose }).exec()
}

/**
 * Đổi mã lấy quyền đi tiếp. Đúng thì bản ghi bị XOÁ — mã dùng đúng một lần.
 *
 * Mọi nhánh hỏng đều ném CÙNG MỘT câu: không phân biệt "chưa xin mã", "mã hết hạn", "mã sai".
 * Phân biệt ra là nói cho người đang dò biết họ dò đúng hướng nào.
 */
export async function consumeCode(
  userId: Types.ObjectId,
  purpose: CodePurpose,
  code: string,
): Promise<void> {
  const wrong = () => new BadRequestError('Mã không đúng hoặc đã hết hạn')

  const row = await EmailVerification.findOne({ userId, purpose }).exec()
  // `expiresAt` so tay chứ không dựa TTL index: Mongo quét mỗi ~60 giây nên bản ghi hết hạn vẫn
  // đọc được một lúc — xem ghi chú ở chỗ khai index.
  if (!row || row.expiresAt.getTime() <= Date.now() || row.attempts >= MAX_ATTEMPTS) throw wrong()

  if (!(await verify(code, row.codeHash))) {
    const after = await EmailVerification.findOneAndUpdate(
      { _id: row._id },
      { $inc: { attempts: 1 } },
      { new: true },
    ).exec()
    // Chạm trần thì XOÁ, không để bản ghi chết nằm lại: người dùng xin lại là có mã mới ngay,
    // còn kẻ đang dò mất luôn mục tiêu.
    if (after && after.attempts >= MAX_ATTEMPTS) {
      await EmailVerification.deleteOne({ _id: row._id }).exec()
    }
    throw wrong()
  }

  await EmailVerification.deleteOne({ _id: row._id }).exec()
}
