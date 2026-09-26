import { randomUUID } from 'node:crypto'
import { userRepository } from '../user/user.repository'
import { IUserDocument } from '../user/user.model'
import { ChangePasswordInput, RegisterInput, LoginInput } from './auth.schema'
import { AuthResult } from './auth.types'
import { BadRequestError, ConflictError, UnauthorizedError } from '../../common/errors'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../common/utils/jwt'
import { logger } from '../../config/logger'
import { env } from '../../config/env'
import { verifyGoogleIdToken } from './google.verify'
import { disconnectUser } from '../../sockets/emit'

function issueTokens(user: IUserDocument, jti: string) {
  const sub = user._id.toString()
  return {
    accessToken: signAccessToken({ sub }),
    // Chỉ refresh token mang `ver` và `jti` — xem `JwtPayload` về việc vì sao access thì không.
    refreshToken: signRefreshToken({ sub, ver: user.tokenVersion, jti }),
  }
}

/** Mở PHIÊN mới (đăng ký, đăng nhập): một `jti` cho refresh token, ghi vào `user.sessions`. */
async function startSession(user: IUserDocument) {
  const jti = randomUUID()
  await userRepository.addSession(user._id, jti)
  return issueTokens(user, jti)
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

    let user: IUserDocument
    try {
      user = await userRepository.create({
        name: input.name,
        email: input.email,
        phone: input.phone,
        password: input.password,
        /*
         * Cờ TẠM THỜI cho vòng kiểm duyệt — xem `SKIP_EMAIL_VERIFICATION` ở `config/env`.
         *
         * `undefined` khi tắt, không phải `null`: để `default` của model quyết định, y như trước
         * khi có dòng này. Gỡ về sau = xoá đúng dòng này và cờ kia.
         */
        ...(env.SKIP_EMAIL_VERIFICATION ? { emailVerifiedAt: new Date() } : {}),
      })
    } catch (err) {
      // Hai lượt đăng ký cùng email cùng lúc: `existsByEmail` ở trên cho cả hai qua, unique index
      // chặn lượt sau — trả 409 như lượt kiểm trước, không phải 500 (audit 3.12).
      if ((err as { code?: number }).code === 11000)
        throw new ConflictError('Email đã được đăng ký')
      throw err
    }
    return { user, ...(await startSession(user)) }
  },

  /**
   * Đăng nhập / đăng ký bằng Google — MỘT đường cho cả hai, vì client không biết trước tài khoản
   * đã tồn tại chưa và không nên biết (hỏi trước là dựng ra một endpoint dò email).
   *
   * Ba nhánh, theo đúng thứ tự này:
   *
   * 1. **Khớp `googleId`** → đăng nhập. Khớp theo `sub` TRƯỚC email vì `sub` không đổi khi người
   *    dùng đổi địa chỉ Gmail; khớp email trước là tạo tài khoản thứ hai cho cùng một người.
   * 2. **Khớp email** → LIÊN KẾT, và rút mật khẩu cũ.
   * 3. Không khớp gì → tạo tài khoản mới, không mật khẩu.
   *
   * ── Vì sao nhánh 2 phải rút mật khẩu ──
   *
   * Đây là chốt chống "chiếm tài khoản trước" (pre-hijacking): kẻ tấn công đăng ký
   * `nan-nhan@gmail.com` bằng mật khẩu TRƯỚC khi chủ hộp thư kịp dùng Google. Nếu ta liên kết mà
   * giữ mật khẩu, chủ thật đăng nhập Google vào đúng tài khoản của kẻ tấn công — và kẻ đó vẫn
   * còn mật khẩu, tức vẫn đọc được tin nhắn lẫn tin đăng của họ mãi về sau.
   *
   * Rút mật khẩu giải quyết dứt điểm vì nó xếp lại thứ tự bằng chứng: một lượt đăng nhập Google
   * chứng minh người này ĐANG kiểm soát hộp thư; một mật khẩu chỉ chứng minh ai đó từng gõ một
   * chuỗi. Ở hệ này vế thứ hai còn yếu hơn bình thường — KHÔNG có luồng xác thực email nào, nên
   * `emailVerifiedAt` của mọi tài khoản mật khẩu đều là `null`.
   *
   * Không ai bị khoá ra ngoài: hộp thư vẫn là hộp thư đó nên cửa Google luôn mở. Họ mất một cửa,
   * không mất tài khoản. Đổi lại `$inc tokenVersion` cắt mọi phiên đang mở ở máy khác.
   */
  async withGoogle(idToken: string): Promise<AuthResult> {
    const identity = await verifyGoogleIdToken(idToken)

    const linked = await userRepository.findByGoogleId(identity.googleId)
    if (linked) {
      if (!linked.isActive) throw new UnauthorizedError('Account is disabled')
      await userRepository.updateById(linked._id, { lastLoginAt: new Date() })
      return { user: linked, ...(await startSession(linked)) }
    }

    const sameEmail = await userRepository.findByEmail(identity.email)
    if (sameEmail) {
      /*
       * Chặn TRƯỚC khi liên kết, không phải sau: một tài khoản bị khoá mà liên kết được thì
       * `$inc tokenVersion` vẫn chạy và mật khẩu vẫn bị rút — tức lệnh khoá của quản trị lại
       * thành đường đổi chủ tài khoản.
       */
      if (!sameEmail.isActive) throw new UnauthorizedError('Account is disabled')

      const user = await userRepository.linkGoogle(sameEmail._id, identity.googleId)
      if (!user) throw new UnauthorizedError('Không liên kết được tài khoản Google')

      logger.info('google account linked, password retired', { userId: user._id.toString() })
      await userRepository.updateById(user._id, { lastLoginAt: new Date() })
      return { user, ...(await startSession(user)) }
    }

    /*
     * Tài khoản mới: KHÔNG có `password`, và `emailVerifiedAt` đặt luôn — Google vừa chứng minh
     * hộp thư. `avatar` nhận ảnh Google: đó là URL của Google chứ không phải Cloudinary, nên nó
     * KHÔNG đi qua đường kiểm duyệt ảnh và cũng không bị job dọn ảnh mồ côi nhặt.
     */
    const created = await userRepository.create({
      name: identity.name,
      email: identity.email,
      googleId: identity.googleId,
      avatar: identity.picture,
      emailVerifiedAt: new Date(),
    })
    logger.info('google account created', { userId: created._id.toString() })
    return { user: created, ...(await startSession(created)) }
  },

  /** Đăng nhập toàn cục: email unique toàn hệ thống nên không cần biết org. */
  async login({ email, password }: LoginInput): Promise<AuthResult> {
    const user = await userRepository.findByEmail(email, { withPassword: true })
    if (!user) throw new UnauthorizedError('Invalid email or password')
    if (!user.isActive) throw new UnauthorizedError('Account is disabled')

    const matched = await user.comparePassword(password)
    if (!matched) throw new UnauthorizedError('Invalid email or password')

    await userRepository.updateById(user._id, { lastLoginAt: new Date() })
    return { user, ...(await startSession(user)) }
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

    /*
     * Token phát trước lần đăng xuất gần nhất thì chết ở đây.
     *
     * `?? 0` cho token cũ phát trước khi có trường này — chúng không mang `ver`, và tài
     * khoản chưa từng đăng xuất cũng đang ở 0, nên hai bên khớp. Không ai bị đá ra lúc deploy.
     */
    if ((payload.ver ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedError('Phiên đã kết thúc — đăng nhập lại')
    }

    /*
     * XOAY refresh token (audit 3.7): mỗi lượt refresh phát cặp mới và vô hiệu token vừa dùng.
     * `jti` là khoá của phiên; CAS trên jti cũ nên đúng một lượt thắng. Thua = token này đã được
     * xoay trước đó, tức ai đó đang cầm bản sao — cắt MỌI phiên của tài khoản: không biết bên nào
     * là kẻ trộm, và cái giá của đoán sai là để kẻ trộm ở lại. Người thật chỉ phải đăng nhập lại.
     */
    if (payload.jti) {
      const newJti = randomUUID()
      const rotated = await userRepository.rotateSession(user._id, payload.jti, newJti)
      if (!rotated) {
        await userRepository.bumpTokenVersion(user._id)
        disconnectUser(user._id.toString())
        logger.warn('auth: refresh token reuse detected — every session revoked', {
          userId: user._id.toString(),
        })
        throw new UnauthorizedError('Phiên không hợp lệ — đăng nhập lại trên mọi thiết bị')
      }
      return { user, ...issueTokens(user, newJti) }
    }

    // Token phát trước bản này không mang `jti`: nhận một lần và đưa vào phiên có jti — từ lượt
    // sau nó xoay như mọi token khác. Không đá ai ra lúc deploy.
    return { user, ...(await startSession(user)) }
  },

  /**
   * Đổi mật khẩu khi ĐANG đăng nhập (audit 3.8). Đòi mật khẩu hiện tại: access token bị lộ chỉ
   * sống 15 phút và không đủ để đổi khoá nhà. Thành công thì cắt mọi phiên khác — người đổi mật
   * khẩu thường đang nghi ngờ gì đó — và phát cặp token mới cho chính máy này để họ không bị đá.
   */
  async changePassword(userId: string, input: ChangePasswordInput): Promise<AuthResult> {
    const user = await userRepository.findById(userId, { withPassword: true })
    if (!user) throw new UnauthorizedError('User no longer valid')
    // Tài khoản Google chưa từng đặt mật khẩu: không có gì để "hiện tại". Đường đúng là quên mật
    // khẩu — mã về hộp thư chứng minh đúng thứ mật khẩu cũ định chứng minh.
    if (!user.password) {
      throw new BadRequestError('Tài khoản chưa có mật khẩu — dùng "Quên mật khẩu" để đặt lần đầu')
    }
    if (!(await user.comparePassword(input.currentPassword))) {
      throw new UnauthorizedError('Mật khẩu hiện tại không đúng')
    }
    if (input.currentPassword === input.newPassword) {
      throw new BadRequestError('Mật khẩu mới phải khác mật khẩu hiện tại')
    }

    user.password = input.newPassword
    // `pre('save')` băm — cùng đường với đăng ký và đặt lại.
    await user.save()
    await userRepository.bumpTokenVersion(user._id)
    disconnectUser(user._id.toString())
    logger.info('auth: password changed, other sessions revoked', { userId })

    const fresh = await userRepository.findById(user._id)
    return { user: fresh!, ...(await startSession(fresh!)) }
  },

  /**
   * Đăng xuất — cắt MỌI phiên của tài khoản này, trên mọi thiết bị.
   *
   * Với refresh token stateless thì chỉ có đúng hai hành vi khả dĩ: không cắt được gì, hoặc
   * cắt sạch. Cắt sạch là lựa chọn đúng cho ca người ta thật sự cần tới nút này — nghi bị lộ
   * tài khoản, hoặc vừa mất điện thoại. `user.sessions` (jti từng thiết bị) đã có từ audit 3.7,
   * nên đăng xuất TỪNG THIẾT BỊ giờ chỉ còn là một endpoint nhận jti — để dành khi sản phẩm cần.
   *
   * Access token đang cầm vẫn sống tối đa 15 phút nữa: đó là cái giá đã biết của việc không
   * đọc DB ở mọi request. Cửa sổ đó chấp nhận được; 30 ngày thì không.
   */
  async logout(userId: string): Promise<void> {
    await userRepository.bumpTokenVersion(userId)
    logger.info('auth: đăng xuất mọi thiết bị', { userId })
  },
}
