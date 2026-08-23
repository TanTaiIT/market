import { z } from 'zod'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const bannedPhraseParamsSchema = z.object({ id: objectId })

export const createBannedPhraseSchema = z
  .object({
    /**
     * Chuẩn hoá NGAY Ở CỬA (trim + lowercase) chứ không đợi tầng model: unique index so bản
     * đã chuẩn hoá, để "Pháo Nổ " và "pháo nổ" là một cụm — không phải hai dòng lách nhau.
     * min 2: cụm một ký tự khớp gần như mọi tin, thêm vào là tự đóng cửa sàn.
     */
    phrase: z
      .string()
      .trim()
      .toLowerCase()
      .min(2, 'Cụm cấm phải từ 2 ký tự')
      .max(100)
      .openapi({ example: 'pháo nổ' }),
  })
  .strict()
  .openapi('CreateBannedPhrase')

export type CreateBannedPhraseInput = z.infer<typeof createBannedPhraseSchema>

export const bannedPhraseResponseSchema = z
  .object({
    _id: z.string(),
    phrase: z.string(),
    addedBy: z.string(),
    createdAt: z.string(),
  })
  .openapi('BannedPhrase')
