import { Request } from 'express'
import { env } from '../config/env'
import { catchAsync } from '../common/utils/catchAsync'
import { ForbiddenError } from '../common/errors'
import { runWithTenant } from '../common/tenant/tenantContext'
import { verifyAccessToken, TOKEN_TYPE } from '../common/utils/jwt'
import {
  organizationRepository,
  OrgSummary,
} from '../features/organization/organization.repository'

function subdomainSlug(hostname: string): string | null {
  const base = env.APP_BASE_DOMAIN
  if (!base || !hostname.endsWith(`.${base}`)) return null

  const sub = hostname.slice(0, -(base.length + 1))
  return sub && sub !== 'www' ? sub : null
}

/** Fallback dev/demo khi chưa có hạ tầng subdomain — chỉ luồng login gửi field này. */
function bodySlug(req: Request): string | null {
  const slug = (req.body as { orgSlug?: unknown } | undefined)?.orgSlug
  return typeof slug === 'string' && slug ? slug : null
}

function tokenOrganizationId(req: Request): string | null {
  const header = req.headers.authorization ?? ''
  if (!header.startsWith('Bearer ')) return null

  try {
    const payload = verifyAccessToken(header.slice(7))
    return payload.type === TOKEN_TYPE.USER ? payload.organizationId : null
  } catch {
    // Token hỏng/hết hạn: để `authenticate` trả 401 với thông điệp đúng, đừng đoán tenant ở đây.
    return null
  }
}

async function resolveOrganization(req: Request): Promise<OrgSummary | null> {
  const slug = subdomainSlug(req.hostname) ?? bodySlug(req)
  if (slug) {
    const org = await organizationRepository.findActiveBySlug(slug)
    if (!org) throw new ForbiddenError('Organization không tồn tại hoặc đã bị khoá')
    return org
  }

  const orgId = tokenOrganizationId(req)
  if (!orgId) return null

  const org = await organizationRepository.findActiveById(orgId)
  // Đọc status LIVE mỗi request: suspend phải có hiệu lực ngay, không phụ thuộc hạn token.
  if (!org) throw new ForbiddenError('Organization đã bị khoá hoặc không còn tồn tại')
  return org
}

/**
 * Mở tenant scope cho toàn bộ phần còn lại của request. Nguồn org theo thứ tự ưu tiên:
 * subdomain → `orgSlug` trong body (login dev/demo) → `organizationId` trong JWT.
 *
 * Không có nguồn nào (vd `/auth/register` tạo org mới) thì KHÔNG mở scope — tenantPlugin
 * fail-closed sẽ chặn nếu request đó lỡ chạm collection có tenant.
 */
export const resolveTenant = catchAsync(async (req, _res, next) => {
  const org = await resolveOrganization(req)
  if (!org) return next()

  const chainOrgIds = org.chainId
    ? await organizationRepository.activeIdsByChain(org.chainId)
    : [org._id]

  // Cache chain có thể trễ vài chục giây; ép org của chính mình luôn đọc được.
  const readable = chainOrgIds.some((id) => id.equals(org._id))
    ? chainOrgIds
    : [org._id, ...chainOrgIds]

  runWithTenant({ ownOrgId: org._id, chainOrgIds: readable }, next)
})
