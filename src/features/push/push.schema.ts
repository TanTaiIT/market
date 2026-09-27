import { z } from 'zod'
import { PUSH_CATEGORIES, PUSH_PLATFORM } from '../../common/constants'
import { registry } from '../../config/openapi'
import { LOCKED_PUSH_CATEGORIES, OPTIONAL_PUSH_CATEGORIES, isExpoPushToken } from './push.policy'

const platform = z.enum([PUSH_PLATFORM.IOS, PUSH_PLATFORM.ANDROID])

const pushToken = z
  .string()
  .trim()
  .refine(isExpoPushToken, 'Push token không hợp lệ')
  .openapi({ example: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' })

export const registerPushDeviceSchema = z
  .object({
    token: pushToken,
    platform: platform,
    appVersion: z.string().trim().max(40).optional(),
    deviceName: z.string().trim().max(100).optional(),
  })
  .strict()
  .openapi('RegisterPushDevice')
export type RegisterPushDeviceInput = z.infer<typeof registerPushDeviceSchema>

export const unregisterPushDeviceSchema = z
  .object({ token: pushToken })
  .strict()
  .openapi('UnregisterPushDevice')

/** Chỉ nhóm TẮT ĐƯỢC mới có mặt — gửi `account` lên là 400, không phải "nhận rồi lặng lẽ bỏ qua". */
const optionalCategoryFlags = z
  .object(
    Object.fromEntries(OPTIONAL_PUSH_CATEGORIES.map((c) => [c, z.boolean().optional()])) as Record<
      string,
      z.ZodOptional<z.ZodBoolean>
    >,
  )
  .strict()

export const updatePushPreferencesSchema = z
  .object({
    enabled: z.boolean().optional(),
    categories: optionalCategoryFlags.optional(),
  })
  .strict()
  .openapi('UpdatePushPreferences')
export type UpdatePushPreferencesInput = z.infer<typeof updatePushPreferencesSchema>

export const pushPreferencesResponseSchema = z
  .object({
    enabled: z.boolean(),
    categories: z.object(
      Object.fromEntries(PUSH_CATEGORIES.map((c) => [c, z.boolean()])) as Record<
        string,
        z.ZodBoolean
      >,
    ),
    /** Nhóm luôn bật — app vẽ công tắc khoá cho chúng. */
    locked: z.array(z.enum(LOCKED_PUSH_CATEGORIES as [string, ...string[]])),
  })
  .openapi('PushPreferences')

export const pushDeviceResponseSchema = z
  .object({
    id: z.string(),
    platform: platform,
    appVersion: z.string(),
    deviceName: z.string(),
    lastSeenAt: z.string(),
  })
  .openapi('PushDevice')

export const pushTestResponseSchema = z
  .object({
    /** Số máy còn nhận của tài khoản này — 0 thì app nói "máy này chưa đăng ký nhận thông báo". */
    devices: z.number().int(),
  })
  .openapi('PushTestResult')

registry.register('RegisterPushDevice', registerPushDeviceSchema)
registry.register('UnregisterPushDevice', unregisterPushDeviceSchema)
registry.register('UpdatePushPreferences', updatePushPreferencesSchema)
registry.register('PushPreferences', pushPreferencesResponseSchema)
registry.register('PushDevice', pushDeviceResponseSchema)
registry.register('PushTestResult', pushTestResponseSchema)
