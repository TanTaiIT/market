import { createHash, timingSafeEqual } from 'node:crypto'
import { userRepository } from '../user/user.repository'
import { IUserDocument } from '../user/user.model'
import { roleGrantRepository } from '../role-grant/role-grant.repository'
import { BootstrapMasterInput, RegisterInput, LoginInput } from './auth.schema'
import { AuthResult } from './auth.types'
import { SCOPE_TYPES, SYSTEM_ROLES } from '../../common/constants'
import { ConflictError, NotFoundError, UnauthorizedError } from '../../common/errors'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../common/utils/jwt'
import { env } from '../../config/env'
import { logger } from '../../config/logger'

/**
 * So chuỗi bí mật theo THỜI GIAN CỐ ĐỊNH. `===` thoát ngay ở ký tự khác đầu tiên, nên thời
 * gian trả lời rò rỉ độ dài tiền tố đúng — đủ để dò từng ký tự qua mạng.
 *
 * Băm hai vế trước khi so là để `timingSafeEqual` luôn nhận hai buffer bằng nhau: nó ném lỗi
 * khi độ dài lệch, mà chính việc ném lỗi đó lại làm lộ độ dài token.
 */
function sameToken(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function issueTokens(user: IUserDocument) {
  const payload = { sub: user._id.toString() }
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  }
}

export const authService = {
  /**
   * Đăng ký = tạo TÀI KHOẢN, không tạo tổ chức.
   *
   * Chỉ master tạo được org (quyết định Q2), và người đăng tin ở trục danh mục không thuộc org
   * nào cả — bắt chọn org ở bước đăng ký là chặn chết nguyên một trục. Muốn vào một org thì
   * gửi request tham gia từ trang profile (`POST /join-requests`).
   */
  async register(input: RegisterInput): Promise<AuthResult> {
    if (await userRepository.existsByEmail(input.email)) {
      throw new ConflictError('Email đã được đăng ký')
    }

    const user = await userRepository.create({
      name: input.name,
      email: input.email,
      phone: input.phone,
      password: input.password,
    })
    return { user, ...issueTokens(user) }
  },

  /** Đăng nhập toàn cục: email unique toàn hệ thống nên không cần biết org. */
  async login({ email, password }: LoginInput): Promise<AuthResult> {
    const user = await userRepository.findByEmail(email, { withPassword: true })
    if (!user) throw new UnauthorizedError('Invalid email or password')
    if (!user.isActive) throw new UnauthorizedError('Account is disabled')

    const matched = await user.comparePassword(password)
    if (!matched) throw new UnauthorizedError('Invalid email or password')

    await userRepository.updateById(user._id, { lastLoginAt: new Date() })
    return { user, ...issueTokens(user) }
  },

  async refresh(refreshToken: string): Promise<AuthResult> {
    let payload
    try {
      payload = verifyRefreshToken(refreshToken)
    } catch {
      throw new UnauthorizedError('Invalid or expired refresh token')
    }

    const user = await userRepository.findById(payload.sub)
    if (!user || !user.isActive) throw new UnauthorizedError('User no longer valid')

    return { user, ...issueTokens(user) }
  },

  /**
   * Dựng tài khoản master — đường DUY NHẤT tạo master đầu tiên.
   *
   * Tồn tại vì bootstrap là bài toán con gà - quả trứng: `POST /role-grants` cấp được master
   * nhưng chỉ master mới gọi được nó, nên master ĐẦU TIÊN không có đường nào ngoài chạm thẳng
   * vào DB. Endpoint này là đường đó, và vì thế nó là bề mặt nguy hiểm nhất của cả API.
   *
   * Ba lớp chắn, không lớp nào thừa:
   * 1. Thiếu `MASTER_SETUP_TOKEN` trong môi trường → 404 y như path không tồn tại. Đây là chốt
   *    chính: môi trường nào không cố ý bật thì không có endpoint này.
   * 2. Token sai → 404, KHÔNG phải 401. Trả 401 là xác nhận "có endpoint ở đây, sai mật khẩu
   *    thôi" — biến nó thành đích để dò.
   * 3. `authLimiter` ở tầng route (10 req/phút) + token tối thiểu 32 ký tự.
   *
   * Idempotent: email đã có thì giữ tài khoản, đặt lại mật khẩu, bổ sung grant nếu thiếu.
   * Chạy lại không sinh grant trùng.
   *
   * Tài khoản đang bị KHOÁ sẽ được mở lại — bootstrap mà để lại một master không đăng nhập
   * được thì vô nghĩa. Không phải leo thang quyền (ai có token đã nắm cả hệ thống), nhưng là
   * tác dụng phụ nên `logger.warn` ghi cờ `reactivated` để nó không lặng lẽ.
   */
  async bootstrapMaster(input: BootstrapMasterInput) {
    const expected = env.MASTER_SETUP_TOKEN
    if (!expected || !sameToken(input.setupToken, expected)) {
      throw new NotFoundError('Not found')
    }

    const email = input.email.toLowerCase()
    const existing = await userRepository.findByEmail(email)
    const created = !existing
    const reactivated = Boolean(existing && !existing.isActive)

    let user: IUserDocument
    if (existing) {
      // `save()` chứ không `updateById`: hook băm mật khẩu nằm ở `pre('save')`, bỏ qua nó là
      // ghi mật khẩu nguyên văn vào DB rồi đăng nhập không bao giờ khớp.
      existing.password = input.password
      existing.isActive = true
      user = await existing.save()
    } else {
      user = await userRepository.create({
        name: input.name?.trim() || email.split('@')[0],
        email,
        password: input.password,
        emailVerifiedAt: new Date(),
      })
    }

    const grants = await roleGrantRepository.listActiveByUser(user._id)
    const granted = !grants.some(
      (g) => g.role === SYSTEM_ROLES.MASTER && g.scopeType === SCOPE_TYPES.SYSTEM,
    )
    if (granted) {
      await roleGrantRepository.create({
        userId: user._id,
        role: SYSTEM_ROLES.MASTER,
        scopeType: SCOPE_TYPES.SYSTEM,
      })
    }

    // Đếm NGƯỜI còn đăng nhập được, không đếm bản ghi grant — cùng phép đếm mà chốt §5.4 dùng
    // (`usableMastersExcluding`). Đếm grant suông sẽ báo "còn 3 master" trong khi hai trong số
    // đó là tài khoản đã xoá mềm.
    const masterIds = await roleGrantRepository.listActiveMasterUserIds()
    const totalMasters = await userRepository.countUsable(masterIds)

    // `warn` chứ không `info`: một lượt cấp quyền master phải nổi lên trong log tổng.
    const result = { userId: user._id.toString(), email, created, granted, totalMasters }
    logger.warn('master bootstrapped over HTTP', { ...result, reactivated })
    return result
  },
}
