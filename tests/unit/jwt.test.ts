import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../../src/common/utils/jwt'
import { env } from '../../src/config/env'

const SUB = '0123456789abcdef01234567'

/**
 * Hai loại token phải KHÔNG dùng chéo được, kể cả khi cấu hình sai (hai secret trùng nhau).
 * Chốt dựa vào hình dạng payload — refresh mang `ver`, access thì không — chứ không chỉ vào
 * secret, nên các ca dưới đây cố tình ký bằng "nhầm" secret để chứng minh điều đó.
 */
describe('JWT — access và refresh không đổi vai cho nhau', () => {
  it('access token phát ra thì qua đúng cửa của nó', () => {
    const payload = verifyAccessToken(signAccessToken({ sub: SUB }))
    expect(payload).toMatchObject({ sub: SUB, typ: 'access' })
  })

  it('refresh token phát ra thì qua đúng cửa của nó', () => {
    const payload = verifyRefreshToken(signRefreshToken({ sub: SUB, ver: 3 }))
    expect(payload).toMatchObject({ sub: SUB, ver: 3, typ: 'refresh' })
  })

  it('refresh token KHÔNG đi qua cửa access, dù ký bằng chính secret của access', () => {
    const forged = jwt.sign({ sub: SUB, ver: 0, typ: 'refresh' }, env.JWT_SECRET)
    expect(() => verifyAccessToken(forged)).toThrow()
  })

  it('refresh token đời cũ (chưa có `typ`) vẫn bị chặn ở cửa access nhờ `ver`', () => {
    const legacy = jwt.sign({ sub: SUB, ver: 0 }, env.JWT_SECRET)
    expect(() => verifyAccessToken(legacy)).toThrow()
  })

  it('access token KHÔNG đi qua cửa refresh — kể cả token trần không `ver`', () => {
    const forged = jwt.sign({ sub: SUB, typ: 'access' }, env.JWT_REFRESH_SECRET)
    expect(() => verifyRefreshToken(forged)).toThrow()
    // Lọt qua đây là khớp `tokenVersion` 0 của mọi tài khoản chưa từng đăng xuất.
    const bare = jwt.sign({ sub: SUB }, env.JWT_REFRESH_SECRET)
    expect(() => verifyRefreshToken(bare)).toThrow()
  })

  it('access token đời cũ (không `typ`, không `ver`) vẫn hợp lệ — không ép đăng nhập lại', () => {
    const legacy = jwt.sign({ sub: SUB }, env.JWT_SECRET)
    expect(verifyAccessToken(legacy).sub).toBe(SUB)
  })
})
