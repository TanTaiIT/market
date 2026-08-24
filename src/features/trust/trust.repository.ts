import { Types } from 'mongoose'
import { UserTrust } from './trust.model'
import { TrustState, INITIAL_TRUST, nextTrust } from './trust.policy'
import { logger } from '../../config/logger'

type Id = string | Types.ObjectId

/** Số lần thử lại khi có lượt duyệt khác chen vào giữa đọc và ghi. */
const CAS_RETRIES = 3

/** Mã lỗi unique index của MongoDB. */
const DUPLICATE_KEY = 11000

/**
 * Đọc trạng thái, KHÔNG hydrate document.
 *
 * `.lean()` + `.select()` vì đây nằm trên đường nóng: mỗi lượt `POST /listings` và mỗi lần mở
 * màn quota đều gọi qua đây, mà thứ cần chỉ là hai con số.
 */
async function readState(userId: Id): Promise<TrustState | null> {
  const doc = await UserTrust.findOne({ userId }).select('level cleanApprovals').lean().exec()
  return doc ? { level: doc.level, cleanApprovals: doc.cleanApprovals } : null
}

const same = (a: TrustState, b: TrustState) =>
  a.level === b.level && a.cleanApprovals === b.cleanApprovals

export const trustRepository = {
  async levelOf(userId: Id): Promise<number> {
    // Không bản ghi = tài khoản mới = bậc trần. Xem `INITIAL_TRUST` cho lý do.
    return (await readState(userId))?.level ?? INITIAL_TRUST.level
  },

  /**
   * Cả trạng thái, không chỉ bậc: `postingStanding` phải biết CHUỖI SẠCH đang đi được bao xa
   * mới nói đúng "còn mấy tin nữa" — chỉ có bậc thì luôn nói quá với người đang dở dang.
   */
  async stateOf(userId: Id): Promise<TrustState> {
    return (await readState(userId)) ?? INITIAL_TRUST
  },

  /**
   * Bậc của nhiều người một lượt — cho danh bạ thành viên, tránh N+1.
   *
   * Map CHỈ chứa người đã có bản ghi. Ai vắng mặt là chưa từng bị chấm, và mặc định của họ là
   * `INITIAL_TRUST.level` chứ KHÔNG phải 0 — caller phải điền đúng cái đó.
   */
  async levelsOf(userIds: Types.ObjectId[]): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map()
    const rows = await UserTrust.find({ userId: { $in: userIds } })
      .select('userId level')
      .lean()
      .exec()
    return new Map(rows.map((row) => [row.userId.toString(), row.level]))
  },

  /**
   * Ghi một lượt duyệt. Luật nằm ở `nextTrust`, đây chỉ lo chuyện ghi cho đúng.
   *
   * Compare-and-set chứ không phải đọc-sửa-ghi: hai quản trị duyệt hai tin của cùng một người
   * bán trong cùng một khoảnh khắc sẽ cùng đọc `cleanApprovals = 4` rồi cùng ghi `5` — mất đứt
   * một lượt duyệt. Điều kiện lọc theo trạng thái ĐÃ ĐỌC khiến lượt thua không khớp document
   * nào và phải đọc lại. Đây là lỗi bản cũ mắc ở cả hai trục.
   *
   * Hai round-trip (đọc rồi ghi) là cái giá đã cân nhắc: gộp thành một \`update\` bằng
   * aggregation pipeline sẽ nhanh hơn một nhịp, nhưng phải viết lại luật thăng/giáng bằng ngôn
   * ngữ query của Mongo — tức là dựng lại đúng bản sao thứ hai mà cả đợt refactor này vừa xoá.
   */
  async record(userId: Id, approved: boolean): Promise<TrustState> {
    for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
      const existing = await readState(userId)
      const previous = existing ?? INITIAL_TRUST
      const next = nextTrust(previous, approved)

      // Không đổi gì thì không ghi: từ chối người ĐÃ ở đáy không còn gì để trừ, và nó không
      // có lý do gì để đẻ ra một lượt ghi vô nghĩa. (Từ khi mặc định là bậc trần, đáy là chỗ
      // người vi phạm nhiều lần rơi xuống, không còn là nơi ai bắt đầu.)
      if (same(previous, next)) return next

      // `existing` chứ không phải so `previous === INITIAL_TRUST`: so định danh đối tượng chỉ
      // đúng chừng nào `readState` còn trả đúng cái INITIAL_TRUST đóng băng. Ngày nó trả một
      // object 0 mới toanh, nhánh này lật sang CAS, filter không khớp gì, và lượt duyệt bị bỏ
      // im lặng sau 3 lần thử.
      if (!existing) {
        try {
          await UserTrust.create({ userId, ...next })
          return next
        } catch (err) {
          // CHỈ nuốt lỗi trùng khoá (ai đó vừa tạo trước): mọi lỗi khác phải nổi lên, nếu
          // không thì một lỗi kết nối cũng biến thành "uy tín im lặng không được ghi".
          if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err
          continue
        }
      }

      const updated = await UserTrust.findOneAndUpdate(
        { userId, level: previous.level, cleanApprovals: previous.cleanApprovals },
        { $set: next },
        { new: true },
      ).exec()
      if (updated) return next
    }

    // Hết lượt thử. KHÔNG ném: một nhịp uy tín lệch không đáng để làm hỏng thao tác duyệt tin
    // mà quản trị vừa bấm. Nhưng phải để lại vết — im lặng ở đây là mất dữ liệu không ai biết.
    logger.warn('trust update dropped after CAS retries', { userId: String(userId), approved })
    return (await readState(userId)) ?? INITIAL_TRUST
  },
}
