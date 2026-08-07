import { verifyAccessToken, TOKEN_TYPE } from '../../common/utils/jwt'
import { UnauthorizedError } from '../../common/errors'
import { catchAsync } from '../../common/utils/catchAsync'

/**
 * Nhánh auth hoàn toàn tách khỏi user: không đi qua resolveTenant, không có organizationId,
 * và từ chối token user dù nó hợp lệ về chữ ký.
 */
export const authenticatePlatformAdmin = catchAsync(async (req, _res, next) => {
  const header = req.headers.authorization ?? ''
  if (!header.startsWith('Bearer ')) throw new UnauthorizedError('Missing access token')

  const payload = verifyAccessToken(header.slice(7))
  if (payload.type !== TOKEN_TYPE.PLATFORM_ADMIN) {
    throw new UnauthorizedError('Invalid platform admin token')
  }

  req.platformAdmin = { id: payload.sub, role: payload.role }
  next()
})
