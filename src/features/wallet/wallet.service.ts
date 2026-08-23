import mongoose, { Types } from 'mongoose'
import { walletRepository } from './wallet.repository'
import { IXuTransactionDocument, XuTxType } from './wallet.model'
import { notificationService } from '../notification/notification.service'
import { BadRequestError, InsufficientBalanceError, NotFoundError } from '../../common/errors'
import { buildPaginationMeta, parsePagination } from '../../common/utils/pagination'
import { userRepository } from '../user/user.repository'
import { logger } from '../../config/logger'

export interface ApplyInput {
  userId: Types.ObjectId
  /** Dương = cộng, âm = trừ. `0` bị từ chối: một dòng sổ không đổi gì là rác. */
  amount: number
  type: XuTxType
  /** Khoá chống ghi trùng. Đặt theo NGUỒN gây ra biến động, ví dụ `topup:<paymentId>`. */
  idempotencyKey: string
  note?: string
  refs?: { listingId?: Types.ObjectId; paymentId?: Types.ObjectId; productCode?: string }
}

/**
 * Biến động mà người dùng KHÔNG tự bấm ra — phải báo, không thì tiền vào/ra ví một cách im
 * lặng. Ngược lại `post_fee`/`product_purchase` là hệ quả tức thì của thao tác họ vừa làm và
 * đã nằm trong response, báo thêm chỉ là spam.
 */
const NOTIFIED_TYPES: readonly XuTxType[] = ['topup', 'refund', 'promo_grant', 'admin_adjust']

export const walletService = {
  /**
   * CỬA DUY NHẤT làm đổi số dư. Không repository nào khác được phép chạm `wallets.balance`.
   *
   * Ba tính chất bắt buộc, và cả ba đều nằm trong một transaction Mongo:
   * 1. **Nguyên tử** — ghi sổ cái và đổi số dư cùng sống hoặc cùng chết. Tách đôi là có ngày
   *    ví nói một đằng lịch sử nói một nẻo.
   * 2. **Idempotent** — cùng `idempotencyKey` gọi bao nhiêu lần cũng ra đúng một dòng sổ. Đây
   *    là thứ giữ cho webhook bắn lại (chuyện thường) không nhân đôi tiền của khách.
   * 3. **Không âm** — trừ quá tay thì `$inc` đã chạy bị cuốn ngược, không để lại ví âm.
   */
  async apply(input: ApplyInput): Promise<IXuTransactionDocument> {
    if (!Number.isInteger(input.amount) || input.amount === 0) {
      throw new BadRequestError('Số Xu phải là số nguyên khác 0')
    }

    // Đường nhanh: đã ghi rồi thì trả lại đúng dòng cũ, khỏi mở transaction.
    const seen = await walletRepository.findByIdempotencyKey(input.idempotencyKey)
    if (seen) return seen

    const session = await mongoose.startSession()
    let created: IXuTransactionDocument | undefined
    try {
      await session.withTransaction(async () => {
        const wallet = await walletRepository.applyDelta(input.userId, input.amount, session)
        if (wallet.balance < 0) {
          // Ném ở đây là abort cả transaction — lệnh `$inc` vừa rồi bị cuốn ngược sạch.
          throw new InsufficientBalanceError(
            `Số dư không đủ: cần thêm ${Math.abs(wallet.balance)} Xu`,
          )
        }

        created = await walletRepository.recordTransaction(
          {
            userId: input.userId,
            amount: input.amount,
            type: input.type,
            balanceAfter: wallet.balance,
            idempotencyKey: input.idempotencyKey,
            note: input.note ?? '',
            ...(input.refs && { refs: input.refs }),
          },
          session,
        )
      })
    } catch (err) {
      // Hai request cùng khoá chạy song song: đứa thua cuộc thấy 11000 và lấy lại dòng của
      // đứa thắng — vẫn đúng hợp đồng idempotent, không phải lỗi để ném ra ngoài.
      if (isDuplicateKey(err)) {
        const existing = await walletRepository.findByIdempotencyKey(input.idempotencyKey)
        if (existing) return existing
      }
      throw err
    } finally {
      await session.endSession()
    }

    const tx = created!
    logger.info('wallet applied', {
      userId: input.userId.toString(),
      amount: tx.amount,
      type: tx.type,
      balanceAfter: tx.balanceAfter,
    })

    if (NOTIFIED_TYPES.includes(tx.type)) {
      // Ngoài transaction: hộp thư hỏng không được phép cuốn ngược tiền của khách.
      await notificationService.notifyUser({
        organizationId: null,
        userId: input.userId,
        title: tx.amount > 0 ? 'Ví Xu vừa được cộng' : 'Ví Xu vừa bị trừ',
        body: `${tx.amount > 0 ? '+' : ''}${tx.amount} Xu — số dư còn ${tx.balanceAfter}. ${tx.note}`.trim(),
      })
    }

    return tx
  },

  /** Số dư hiện tại. Ví chưa từng phát sinh giao dịch thì là 0, không phải lỗi. */
  async balanceOf(userId: Types.ObjectId): Promise<number> {
    const wallet = await walletRepository.findByUserId(userId)
    return wallet?.balance ?? 0
  },

  async history(userId: Types.ObjectId, query: { page?: number; limit?: number }) {
    const pagination = parsePagination(query)
    const { items, total } = await walletRepository.paginateTransactions(userId, pagination)
    return {
      items,
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  /**
   * Master cộng/trừ tay — đường tặng Xu khai trương, bồi thường sự cố, thu hồi Xu cấp nhầm.
   *
   * `note` bắt buộc: một dòng sổ do người tạo ra mà không nói vì sao thì tháng sau không ai
   * giải thích được cho khách. Khoá idempotent do caller truyền để master bấm nhầm hai lần
   * không cộng đôi (client sinh một uuid cho mỗi lần mở form).
   */
  async adjust(input: {
    userId: string
    amount: number
    note: string
    idempotencyKey: string
    actorId: string
  }) {
    const target = await userRepository.findById(input.userId)
    if (!target) throw new NotFoundError('User not found')

    const tx = await this.apply({
      userId: target._id,
      amount: input.amount,
      type: 'admin_adjust',
      idempotencyKey: `adjust:${input.idempotencyKey}`,
      note: input.note,
    })
    logger.info('wallet adjusted by master', {
      actorId: input.actorId,
      userId: input.userId,
      amount: input.amount,
    })
    return tx
  },
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000
}
