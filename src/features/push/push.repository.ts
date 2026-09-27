import { randomUUID } from 'node:crypto'
import { Types } from 'mongoose'
import { PUSH_OUTBOX_STATUS, type PushPlatform } from '../../common/constants'
import { PushDevice, PushOutbox, type IPushOutbox, type IPushTicket } from './push.model'
import { CHAT_MANY_SUFFIX, PUSH_LIMITS } from './push.policy'

type Id = Types.ObjectId | string

const DAY_MS = 24 * 60 * 60 * 1000

export type NewOutboxRow = Pick<
  IPushOutbox,
  'userId' | 'category' | 'title' | 'body' | 'data' | 'collapseKey'
> & {
  /** Bỏ trống = gửi ngay. Chat dời tới cuối cửa sổ gộp khi vừa có push của cùng hội thoại. */
  nextAttemptAt?: Date
}

export const pushRepository = {
  // ── DEVICES ────────────────────────────────────────────────────────────────

  /**
   * Upsert THEO TOKEN — xem chú thích index ở model. Hai lượt đăng ký cùng token về cùng lúc (app
   * mở + token đổi) thì một bên nổ E11000 ở nhánh insert; thử lại một lần là thành update.
   */
  async upsertDevice(input: {
    userId: Id
    token: string
    platform: PushPlatform
    appVersion: string
    deviceName: string
  }) {
    const run = () =>
      PushDevice.findOneAndUpdate(
        { token: input.token },
        {
          $set: {
            userId: new Types.ObjectId(input.userId),
            platform: input.platform,
            appVersion: input.appVersion,
            deviceName: input.deviceName,
            provider: 'expo',
            lastSeenAt: new Date(),
            disabledAt: null,
          },
        },
        { upsert: true, new: true },
      ).exec()
    try {
      return await run()
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err
      return run()
    }
  },

  /** Giữ `max` máy dùng gần nhất, bỏ phần đuôi. */
  async trimDevices(userId: Id, max: number) {
    const stale = await PushDevice.find({ userId })
      .sort({ lastSeenAt: -1 })
      .skip(max)
      .select('_id')
      .lean()
      .exec()
    if (stale.length === 0) return 0
    const res = await PushDevice.deleteMany({ _id: { $in: stale.map((d) => d._id) } }).exec()
    return res.deletedCount
  },

  removeByToken(token: string) {
    return PushDevice.deleteOne({ token }).exec()
  },

  removeAllForUser(userId: Id, opts: { exceptToken?: string } = {}) {
    return PushDevice.deleteMany({
      userId,
      ...(opts.exceptToken ? { token: { $ne: opts.exceptToken } } : {}),
    }).exec()
  },

  countActiveForUser(userId: Id) {
    return PushDevice.countDocuments({ userId, disabledAt: null }).exec()
  },

  activeDevicesOf(userIds: Types.ObjectId[]) {
    return PushDevice.find({ userId: { $in: userIds }, disabledAt: null })
      .select('userId token')
      .lean()
      .exec()
  },

  /** Người nào trong danh sách có ít nhất một máy còn nhận — người chưa cài app không tốn dòng outbox. */
  async usersWithDevices(userIds: Types.ObjectId[]): Promise<Types.ObjectId[]> {
    if (userIds.length === 0) return []
    return PushDevice.distinct('userId', { userId: { $in: userIds }, disabledAt: null }).exec()
  },

  disableTokens(tokens: string[]) {
    if (tokens.length === 0) return Promise.resolve(null)
    return PushDevice.updateMany(
      { token: { $in: tokens }, disabledAt: null },
      { $set: { disabledAt: new Date() } },
    ).exec()
  },

  pruneDevices(now: Date) {
    return PushDevice.deleteMany({
      $or: [
        { lastSeenAt: { $lt: new Date(now.getTime() - PUSH_LIMITS.DEVICE_STALE_DAYS * DAY_MS) } },
        {
          disabledAt: {
            $lt: new Date(now.getTime() - PUSH_LIMITS.DEVICE_DISABLED_KEEP_DAYS * DAY_MS),
          },
        },
      ],
    }).exec()
  },

  // ── OUTBOX ─────────────────────────────────────────────────────────────────

  async enqueue(rows: NewOutboxRow[]) {
    const now = new Date()
    for (let i = 0; i < rows.length; i += PUSH_LIMITS.ENQUEUE_CHUNK) {
      await PushOutbox.insertMany(
        rows.slice(i, i + PUSH_LIMITS.ENQUEUE_CHUNK).map((row) => ({
          ...row,
          status: PUSH_OUTBOX_STATUS.PENDING,
          nextAttemptAt: row.nextAttemptAt ?? now,
        })),
        { ordered: false },
      )
    }
  },

  /**
   * Gộp vào dòng chat đang chờ của cùng hội thoại, nếu có. Trả `null` = không có gì để gộp, caller
   * tạo dòng mới. Chỉ gộp dòng CÒN `pending`: dòng đã đi thì tin sau phải là một push mới.
   *
   * MỘT lượt ghi (pipeline update) — tách "tăng đếm" và "ghi lại chữ" thành hai lượt là để hở một
   * khe cho dispatcher claim dòng ở giữa, rồi gửi đi bản chữ cũ với số đếm mới.
   */
  coalesce(userId: Types.ObjectId, collapseKey: string, title: string) {
    return PushOutbox.findOneAndUpdate(
      { userId, collapseKey, status: PUSH_OUTBOX_STATUS.PENDING },
      [
        { $set: { coalescedCount: { $add: ['$coalescedCount', 1] } } },
        {
          $set: {
            title: { $literal: title },
            body: { $concat: [{ $toString: '$coalescedCount' }, CHAT_MANY_SUFFIX] },
          },
        },
      ],
      { new: true },
    ).exec()
  },

  /** Dòng gần nhất cùng khoá gộp đã (hoặc đang) đi trong cửa sổ — quyết định dời hạn dòng kế tiếp. */
  lastSentWithKey(userId: Types.ObjectId, collapseKey: string, since: Date) {
    return PushOutbox.findOne({
      userId,
      collapseKey,
      status: { $in: [PUSH_OUTBOX_STATUS.SENDING, PUSH_OUTBOX_STATUS.SENT] },
      createdAt: { $gte: since },
    })
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean()
      .exec()
  },

  /**
   * Nhận một lô dòng tới hạn — CAS hai bước: chọn id, rồi ghi `claimId` với ĐÚNG điều kiện đã
   * chọn. Hai dispatcher chạy cùng lúc thì dòng mà bên kia vừa claim không còn khớp điều kiện
   * (đã `sending` với `lockedAt` mới), nên mỗi dòng rơi vào đúng một lô.
   */
  async claimDue(now: Date, limit: number) {
    const staleBefore = new Date(now.getTime() - PUSH_LIMITS.CLAIM_STALE_MS)
    const due = {
      $or: [
        { status: PUSH_OUTBOX_STATUS.PENDING, nextAttemptAt: { $lte: now } },
        { status: PUSH_OUTBOX_STATUS.SENDING, lockedAt: { $lt: staleBefore } },
      ],
    }
    const candidates = await PushOutbox.find(due)
      .sort({ nextAttemptAt: 1 })
      .limit(limit)
      .select('_id')
      .lean()
      .exec()
    if (candidates.length === 0) return []

    const claimId = randomUUID()
    await PushOutbox.updateMany(
      { _id: { $in: candidates.map((c) => c._id) }, ...due },
      { $set: { status: PUSH_OUTBOX_STATUS.SENDING, lockedAt: now, claimId } },
    ).exec()
    return PushOutbox.find({ claimId }).exec()
  },

  markSent(id: Types.ObjectId, tickets: IPushTicket[], now: Date) {
    return PushOutbox.updateOne(
      { _id: id },
      {
        $set: {
          status: PUSH_OUTBOX_STATUS.SENT,
          tickets,
          sentAt: now,
          lockedAt: null,
          claimId: null,
          lastError: null,
          receiptsDueAt: tickets.some((t) => t.ticketId)
            ? new Date(now.getTime() + PUSH_LIMITS.RECEIPT_DELAY_MS)
            : null,
        },
        $inc: { attempts: 1 },
      },
    ).exec()
  },

  markRetry(id: Types.ObjectId, at: Date, error: string) {
    return PushOutbox.updateOne(
      { _id: id },
      {
        $set: {
          status: PUSH_OUTBOX_STATUS.PENDING,
          nextAttemptAt: at,
          lockedAt: null,
          claimId: null,
          lastError: error,
        },
        $inc: { attempts: 1 },
      },
    ).exec()
  },

  markDone(
    id: Types.ObjectId,
    status: typeof PUSH_OUTBOX_STATUS.FAILED | typeof PUSH_OUTBOX_STATUS.SKIPPED,
    reason: string,
    tickets?: IPushTicket[],
  ) {
    return PushOutbox.updateOne(
      { _id: id },
      {
        $set: {
          status,
          lastError: reason,
          lockedAt: null,
          claimId: null,
          ...(tickets ? { tickets } : {}),
        },
        ...(status === PUSH_OUTBOX_STATUS.FAILED ? { $inc: { attempts: 1 } } : {}),
      },
    ).exec()
  },

  /** `.lean()`: dispatcher dựng lại mảng ticket rồi ghi đè — spread subdocument Mongoose là mất field. */
  dueReceipts(now: Date, limit: number) {
    return PushOutbox.find({ receiptsDueAt: { $lte: now } })
      .sort({ receiptsDueAt: 1 })
      .limit(limit)
      .lean()
      .exec()
  },

  /** `dueAt` khác `null` = còn ticket Expo chưa có receipt, hỏi lại sau. */
  saveReceipts(id: Types.ObjectId, tickets: IPushTicket[], dueAt: Date | null) {
    return PushOutbox.updateOne({ _id: id }, { $set: { tickets, receiptsDueAt: dueAt } }).exec()
  },

  /** Xoá tài khoản: dòng chưa đi của họ không được đi nữa. */
  deletePendingForUser(userId: Id) {
    return PushOutbox.deleteMany({
      userId,
      status: { $in: [PUSH_OUTBOX_STATUS.PENDING, PUSH_OUTBOX_STATUS.SENDING] },
    }).exec()
  },
}
