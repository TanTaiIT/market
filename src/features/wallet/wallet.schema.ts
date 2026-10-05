import { z } from 'zod'
import { objectId } from '../../common/schemas/objectId'
import { PAGINATION } from '../../common/constants'
import { XU_TX_TYPES, XU_ADJUST_MAX } from './wallet.model'

export const walletHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(PAGINATION.MAX_LIMIT).optional(),
})

export const walletUserParamsSchema = z.object({ userId: objectId })

export const adjustWalletSchema = z
  .object({
    /** Âm để thu hồi. `0` bị chặn ở service — một dòng sổ không đổi gì là rác. */
    amount: z.number().int().min(-XU_ADJUST_MAX).max(XU_ADJUST_MAX).openapi({ example: 100 }),
    note: z.string().trim().min(3).max(300).openapi({ example: 'Tặng Xu khai trương' }),
    /**
     * Client sinh một khoá cho MỖI lần mở form (uuid là đủ). Bấm nhầm hai lần với cùng khoá
     * chỉ ra một dòng sổ — thứ duy nhất ngăn master cộng đôi Xu cho khách.
     */
    idempotencyKey: z.string().trim().min(8).max(80),
  })
  .strict()
  .openapi('AdjustWallet')

export type AdjustWalletInput = z.infer<typeof adjustWalletSchema>

export const walletSchema = z
  .object({
    balance: z.number(),
    currency: z.literal('xu'),
  })
  .openapi('Wallet')

export const xuTransactionSchema = z
  .object({
    _id: z.string(),
    userId: z.string(),
    amount: z.number(),
    type: z.enum(XU_TX_TYPES),
    balanceAfter: z.number(),
    note: z.string(),
    refs: z
      .object({
        listingId: z.string().optional(),
        paymentId: z.string().optional(),
        productCode: z.string().optional(),
      })
      .optional(),
    createdAt: z.string().datetime(),
  })
  .openapi('XuTransaction')
