import { z } from 'zod'
import { registry } from '../../config/openapi'
import { TENANT_STATUS } from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const platformLoginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict()
  .openapi('PlatformAdminLogin')

export const platformLoginResponseSchema = z
  .object({
    admin: z.object({ id: z.string(), email: z.string(), name: z.string(), role: z.string() }),
    accessToken: z.string(),
  })
  .openapi('PlatformAdminAuth')

export const organizationParamsSchema = z.object({ organizationId: objectId })

/** `chainId: null` = tách org ra khỏi chain, chạy độc lập trở lại (§6.3). */
export const assignChainSchema = z
  .object({ chainId: objectId.nullable() })
  .strict()
  .openapi('AssignChain')

export const setOrgStatusSchema = z
  .object({ status: z.nativeEnum(TENANT_STATUS) })
  .strict()
  .openapi('SetOrganizationStatus')

export type PlatformLoginInput = z.infer<typeof platformLoginSchema>
export type AssignChainInput = z.infer<typeof assignChainSchema>
export type SetOrgStatusInput = z.infer<typeof setOrgStatusSchema>

registry.register('PlatformAdminLogin', platformLoginSchema)
registry.register('PlatformAdminAuth', platformLoginResponseSchema)
registry.register('AssignChain', assignChainSchema)
registry.register('SetOrganizationStatus', setOrgStatusSchema)
