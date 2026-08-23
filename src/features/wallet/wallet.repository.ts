import { ClientSession, Types } from 'mongoose'
import { IXuTransaction, Wallet, XuTransaction } from './wallet.model'
import { PaginationParams } from '../../common/utils/pagination'

/**
 * Không có `updateBalance` công khai ở đây — cố ý. Số dư chỉ đổi qua `applyDelta`, và hàm đó
 * bắt buộc nhận `session` vì nó phải đi cùng lượt ghi sổ cái trong một transaction.
 */
export const walletRepository = {
  findByUserId(userId: Types.ObjectId) {
    return Wallet.findOne({ userId }).exec()
  },

  /**
   * Cộng/trừ số dư và trả về trạng thái SAU khi đổi, trong một lệnh nguyên tử duy nhất.
   *
   * `$inc` + `upsert` chứ không phải đọc-rồi-ghi: ví chưa tồn tại thì tạo luôn với đúng số dư
   * đầu tiên, và hai lượt chi song song không thể cùng đọc ra một số dư cũ. Âm số dư thì
   * caller ném lỗi và transaction cuốn ngược lệnh này.
   */
  applyDelta(userId: Types.ObjectId, amount: number, session: ClientSession) {
    return Wallet.findOneAndUpdate(
      { userId },
      { $inc: { balance: amount }, $setOnInsert: { userId } },
      { upsert: true, new: true, session },
    ).exec()
  },

  findByIdempotencyKey(idempotencyKey: string) {
    return XuTransaction.findOne({ idempotencyKey }).exec()
  },

  async recordTransaction(entry: Partial<IXuTransaction>, session: ClientSession) {
    const [tx] = await XuTransaction.create([entry], { session })
    return tx
  },

  async paginateTransactions(userId: Types.ObjectId, { skip, limit }: PaginationParams) {
    const [items, total] = await Promise.all([
      XuTransaction.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      XuTransaction.countDocuments({ userId }).exec(),
    ])
    return { items, total }
  },

  /**
   * Tổng sổ cái của một người — phép ĐỐI SOÁT với `wallets.balance`. Lệch nhau nghĩa là có
   * đường ghi tắt nào đó đã lọt qua `walletService.apply`, và đó là sự cố phải điều tra.
   */
  async ledgerSum(userId: Types.ObjectId): Promise<number> {
    const [row] = await XuTransaction.aggregate<{ total: number }>([
      { $match: { userId } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ])
    return row?.total ?? 0
  },
}
