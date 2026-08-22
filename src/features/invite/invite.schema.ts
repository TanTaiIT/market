import { z } from 'zod'
import { registry } from '../../config/openapi'
import { INVITE_CHANNELS, INVITE_STATUS } from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

/**
 * Kênh chỉ để BIẾT admin gõ cái gì vào — hệ thống không gửi mail hay SMS.
 *
 * Tra ra tài khoản thì lời mời đến qua thông báo trong app; không tra ra thì trả về link để
 * admin tự gửi. Ngày nào có hạ tầng gửi thật, chính field này là chỗ nó cắm vào.
 */
export const createInviteSchema = z
  .object({
    channel: z.nativeEnum(INVITE_CHANNELS),
    value: z.string().min(3).max(120),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.channel !== INVITE_CHANNELS.EMAIL) return
    if (!z.string().email().safeParse(input.value.trim()).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'Email không hợp lệ' })
    }
  })
  .openapi('CreateInvite')

export const inviteParamsSchema = z.object({ id: objectId })

/** Token đi trong URL nên phải chốt hình dạng: 32 byte hex = 64 ký tự. */
export const inviteTokenParamsSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/, 'Token không hợp lệ'),
})

export const inviteResponseSchema = z
  .object({
    id: objectId,
    channel: z.nativeEnum(INVITE_CHANNELS),
    /** Địa chỉ đã chuẩn hoá — admin cần đọc lại "mình đã mời ai". */
    value: z.string(),
    kind: z.enum(['direct', 'link']),
    status: z.nativeEnum(INVITE_STATUS),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .openapi('Invite')

/**
 * Kết quả của một lượt mời. `token` chỉ xuất hiện ở ĐÂY và không bao giờ nữa — nó là bí mật,
 * DB chỉ giữ bản băm.
 */
export const createInviteResponseSchema = z
  .object({
    invite: inviteResponseSchema,
    token: z.string(),
    /** `true` = không tra ra tài khoản nào, admin phải tự gửi link đi. */
    shareable: z.boolean(),
  })
  .openapi('CreateInviteResult')

export const myInviteSchema = z
  .object({
    id: objectId,
    organizationName: z.string(),
    organizationAvatarUrl: z.string().nullable(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .openapi('MyInvite')

export const invitePreviewSchema = z
  .object({
    organizationName: z.string(),
    organizationAvatarUrl: z.string().nullable(),
    description: z.string(),
    memberCount: z.number(),
    expiresAt: z.string().datetime(),
  })
  .openapi('InvitePreview')

export const acceptInviteResponseSchema = z
  .object({ organizationSlug: z.string() })
  .openapi('AcceptInviteResult')

export type CreateInviteInput = z.infer<typeof createInviteSchema>

registry.register('CreateInvite', createInviteSchema)
registry.register('Invite', inviteResponseSchema)
registry.register('CreateInviteResult', createInviteResponseSchema)
registry.register('MyInvite', myInviteSchema)
registry.register('InvitePreview', invitePreviewSchema)
registry.register('AcceptInviteResult', acceptInviteResponseSchema)
