import { z } from 'zod'
import { XU_TX_TYPES } from './wallet.model'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const walletHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

export const walletUserParamsSchema = z.object({ userId: objectId })

export const adjustWalletSchema = z
  .object({
    /** Âm để thu hồi. `0` bị chặn ở service — một dòng sổ không đổi gì là rác. */
    amount: z.number().int().openapi({ example: 100 }),
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
