import { z } from 'zod'
import { Router } from 'express'
import { authController } from './auth.controller'
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  googleAuthSchema,
  authResponseSchema,
  verifyEmailSchema,
  sendCodeResponseSchema,
  forgotPasswordSchema,
  verifyResetCodeSchema,
  resetTicketSchema,
  resetPasswordSchema,
} from './auth.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authLimiter } from '../../middlewares/rateLimiter.middleware'
import { authenticate } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// Rate limit chặt để chống brute-force
router.post('/register', authLimiter, validate({ body: registerSchema }), authController.register)
router.post('/login', authLimiter, validate({ body: loginSchema }), authController.login)
router.post('/refresh', authLimiter, validate({ body: refreshSchema }), authController.refresh)

/*
 * Đăng nhập Google — cùng `authLimiter` với hai đường kia.
 *
 * Giới hạn nhịp vẫn cần dù không có mật khẩu nào để dò: mỗi lượt gọi là một lần xác minh chữ ký
 * (có thể kèm một lượt tải JWKS), nên đây vẫn là một cửa tốn tài nguyên mà chưa cần đăng nhập.
 */
router.post('/google', authLimiter, validate({ body: googleAuthSchema }), authController.google)

/*
 * Đăng xuất — cần access token hợp lệ, KHÔNG nhận refresh token trong body.
 *
 * Nếu nhận refresh token thì ai nhặt được nó cũng đăng xuất được chủ tài khoản: một cú DoS
 * nhắm vào đúng một người, miễn phí. Bắt `authenticate` nghĩa là chỉ người đang có phiên
 * sống mới cắt được phiên của chính mình.
 */
router.post('/logout', authenticate, authController.logout)

/*
 * Xác thực email — cả hai đường đều `authenticate`, và người dùng lấy từ TOKEN chứ không từ body.
 *
 * Nhận email trong body sẽ dựng ra một máy dò tài khoản: gửi thử từng địa chỉ, ai nhận 200 là
 * có tài khoản ở đây. Không mất gì khi bắt đăng nhập — `register` trả luôn phiên, nên client
 * đã cầm token trước khi tới màn nhập mã.
 *
 * `authLimiter` là lưới THỨ HAI. Lưới thứ nhất chặt hơn và nằm trong service: 60 giây giữa hai
 * lượt gửi cho mỗi tài khoản, 5 lần gõ sai là mã chết. Giới hạn theo IP ở đây không thay được
 * chúng — nó chặn một máy quét nhiều tài khoản, còn hai luật kia chặn việc nhắm một tài khoản.
 */
router.post('/email/send-code', authenticate, authLimiter, authController.sendEmailCode)
router.post(
  '/email/verify',
  authenticate,
  authLimiter,
  validate({ body: verifyEmailSchema }),
  authController.verifyEmail,
)

/*
 * Quên mật khẩu — CÔNG KHAI, và phải thế: người quên mật khẩu không đăng nhập được, nên không
 * có token nào để lấy danh tính ra. Email buộc phải nằm trong body, nên cả hai đường đều trả
 * lời giống nhau cho địa chỉ có thật lẫn địa chỉ lạ (xem `passwordResetService`).
 *
 * `authLimiter` (theo IP) ở đây gánh nặng hơn ở luồng xác thực email: chốt 60 giây của service
 * chỉ chặn việc nhắm MỘT tài khoản, còn cửa này mở cho mọi địa chỉ nên một máy quét có thể
 * chạy qua hàng nghìn email mà không lần nào chạm chốt đó.
 */
router.post(
  '/password/forgot',
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  authController.forgotPassword,
)
router.post(
  '/password/verify-code',
  authLimiter,
  validate({ body: verifyResetCodeSchema }),
  authController.verifyResetCode,
)
router.post(
  '/password/reset',
  authLimiter,
  validate({ body: resetPasswordSchema }),
  authController.resetPassword,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
// `operationId` là tên hàm client sau codegen -> phải ổn định và độc lập với path,
// đổi path không được kéo theo đổi tên hàm ở mọi consumer.
const authResponse = envelope(authResponseSchema)

registry.registerPath({
  method: 'post',
  path: '/auth/register',
  operationId: 'authRegister',
  tags: ['Auth'],
  summary: 'Tạo Organization mới + tài khoản owner đầu tiên',
  request: { body: { content: { 'application/json': { schema: registerSchema } } } },
  responses: {
    201: jsonResponse('Đăng ký thành công', authResponse),
    400: errorResponse('Dữ liệu không hợp lệ'),
    409: errorResponse('Organization slug đã tồn tại'),
    429: errorResponse('Quá nhiều request'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/login',
  operationId: 'authLogin',
  tags: ['Auth'],
  summary: 'Đăng nhập trong phạm vi một Organization (subdomain hoặc orgSlug)',
  request: { body: { content: { 'application/json': { schema: loginSchema } } } },
  responses: {
    200: jsonResponse('Đăng nhập thành công', authResponse),
    401: errorResponse('Sai thông tin đăng nhập, tài khoản bị khoá, hoặc thiếu organization'),
    403: errorResponse('Organization không tồn tại hoặc đã bị khoá'),
    429: errorResponse('Quá nhiều request'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/google',
  operationId: 'authGoogle',
  tags: ['Auth'],
  summary: 'Đăng nhập hoặc đăng ký bằng Google',
  description:
    'Nhận `id_token` của Google, xác minh chữ ký + `aud` + `email_verified` ở máy chủ rồi phát ' +
    'token của app. Một cửa cho cả đăng nhập và đăng ký — client không cần biết email đã có tài ' +
    'khoản chưa. **Nếu email đó đã có tài khoản mật khẩu**: tài khoản được LIÊN KẾT và mật khẩu ' +
    'cũ bị RÚT, mọi phiên đang mở ở máy khác bị cắt (`tokenVersion`). Đó là chốt chống chiếm ' +
    'tài khoản trước — xem `authService.withGoogle`. 503 = máy chủ chưa cấu hình `GOOGLE_CLIENT_IDS`.',
  request: { body: { content: { 'application/json': { schema: googleAuthSchema } } } },
  responses: {
    200: jsonResponse('Đăng nhập thành công', authResponse),
    401: errorResponse('Token Google không hợp lệ, email chưa xác thực, hoặc tài khoản bị khoá'),
    429: errorResponse('Quá nhiều request'),
    503: errorResponse('Đăng nhập Google chưa được bật trên máy chủ này'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/refresh',
  operationId: 'authRefresh',
  tags: ['Auth'],
  summary: 'Lấy cặp token mới từ refresh token',
  request: { body: { content: { 'application/json': { schema: refreshSchema } } } },
  responses: {
    200: jsonResponse('Token đã được làm mới', authResponse),
    401: errorResponse('Refresh token hết hạn hoặc không hợp lệ'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/logout',
  operationId: 'authLogout',
  tags: ['Auth'],
  summary: 'Đăng xuất khỏi MỌI thiết bị',
  description:
    'Tăng `tokenVersion` của tài khoản, làm chết mọi refresh token đã phát — kể cả token ' +
    'đang nằm trên máy khác. Access token đang cầm vẫn sống tối đa tới hạn của nó (15 phút); ' +
    'đó là cái giá của việc không đọc DB ở mọi request. Không có đăng xuất từng thiết bị: ' +
    'refresh token là bearer stateless, muốn tách theo thiết bị thì phải có bảng lưu `jti`.',
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: jsonResponse('Đã đăng xuất', envelope(z.null())),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

const emailRoute = { tags: ['Auth'], security: [{ [bearerAuth.name]: [] }] }

registry.registerPath({
  method: 'post',
  path: '/auth/email/send-code',
  operationId: 'authSendEmailCode',
  ...emailRoute,
  summary: 'Gửi mã xác thực 6 số tới email của chính mình',
  description:
    'Địa chỉ nhận lấy từ TOKEN, không nhận trong body — body có email thì endpoint này thành ' +
    'máy dò tài khoản. Mỗi tài khoản chỉ có một mã sống: gọi lại là mã cũ chết ngay. Chờ 60 ' +
    'giây giữa hai lượt gửi, mã sống 10 phút. 503 = máy chủ chưa cấu hình `GMAIL_USER`/`GMAIL_APP_PASSWORD`, hoặc không gửi được thư.',
  responses: {
    200: jsonResponse('Đã gửi mã', envelope(sendCodeResponseSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
    409: errorResponse('Email này đã được xác thực'),
    429: errorResponse('Gửi lại quá sớm, hoặc quá nhiều request'),
    503: errorResponse('Xác thực email chưa được bật, hoặc không gửi được thư'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/email/verify',
  operationId: 'authVerifyEmail',
  ...emailRoute,
  summary: 'Đổi mã 6 số lấy dấu đã xác thực',
  description:
    'Đúng mã thì `emailVerifiedAt` được đặt và bản ghi mã bị xoá — đọc lại `GET /users/me` để ' +
    'thấy `isEmailVerified`. Sai 5 lần thì mã chết, phải gửi lại mã mới. Mọi nhánh hỏng đều trả ' +
    'CÙNG một câu 400: phân biệt "chưa gửi mã" với "mã sai" là chỉ đường cho người đang dò.',
  request: { body: { content: { 'application/json': { schema: verifyEmailSchema } } } },
  responses: {
    200: jsonResponse('Đã xác thực', envelope(z.null())),
    400: errorResponse('Mã không đúng hoặc đã hết hạn'),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

export default router

registry.registerPath({
  method: 'post',
  path: '/auth/password/forgot',
  operationId: 'authForgotPassword',
  tags: ['Auth'],
  summary: 'Xin mã đặt lại mật khẩu (công khai)',
  description:
    'LUÔN trả 200, kể cả khi địa chỉ không có tài khoản, đang bị khoá, hay gửi thư hỏng — phân ' +
    'biệt các ca đó là biến endpoint này thành máy dò tài khoản. Mã 6 số sống 10 phút, chờ 60 ' +
    'giây giữa hai lượt xin. Tài khoản chỉ-Google (không có mật khẩu) cũng xin được: gõ đúng mã ' +
    'chứng minh quyền kiểm soát hộp thư, đúng bằng chứng mà Google cấp hộ.',
  request: { body: { content: { 'application/json': { schema: forgotPasswordSchema } } } },
  responses: {
    200: jsonResponse('Đã tiếp nhận', envelope(z.null())),
    400: errorResponse('Email sai định dạng'),
    429: errorResponse('Quá nhiều request'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/password/reset',
  operationId: 'authResetPassword',
  tags: ['Auth'],
  summary: 'Đổi VÉ lấy mật khẩu mới (công khai)',
  description:
    'Nhận `resetToken` từ `/auth/password/verify-code`, KHÔNG nhận mã 6 số — mã đã bị tiêu thụ ở ' +
    'bước đó. Thành công thì làm BA việc: đặt mật khẩu mới, đánh dấu email đã xác thực (mã vừa ' +
    'chứng minh hộp thư), và `$inc tokenVersion` để CẮT MỌI PHIÊN đang mở — người đặt lại mật ' +
    'khẩu thường đang nghi bị chiếm tài khoản, để phiên của kẻ kia sống tiếp 14 ngày thì chưa ' +
    'giải quyết gì. Vé dùng đúng một lần. Mọi nhánh hỏng trả CÙNG một câu 400 — kể cả email ' +
    'không tồn tại, vì mã trạng thái khác nhau cũng đủ để dò.',
  request: { body: { content: { 'application/json': { schema: resetPasswordSchema } } } },
  responses: {
    200: jsonResponse('Đã đặt lại mật khẩu', envelope(z.null())),
    400: errorResponse('Mã không đúng hoặc đã hết hạn'),
    429: errorResponse('Quá nhiều request'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/password/verify-code',
  operationId: 'authVerifyResetCode',
  tags: ['Auth'],
  summary: 'Đổi mã 6 số lấy vé đặt lại (công khai)',
  description:
    'Bước giữa, tách khỏi bước đặt mật khẩu vì trần 5 lần gõ sai: gộp hai việc thì mỗi lần gõ ' +
    'nhầm mã bắt người dùng gõ lại cả mật khẩu — một ô họ không nhìn thấy để soát — và vẫn đốt ' +
    'một lượt trong năm lượt. Mã bị TIÊU THỤ ở đây; đổi lại là một vé dùng đúng một lần, sống ' +
    '10 phút tính từ lúc phát. Sai 5 lần thì mã chết, phải xin mã mới.',
  request: { body: { content: { 'application/json': { schema: verifyResetCodeSchema } } } },
  responses: {
    200: jsonResponse('Mã hợp lệ', envelope(resetTicketSchema)),
    400: errorResponse('Mã không đúng hoặc đã hết hạn'),
    429: errorResponse('Quá nhiều request'),
  },
})
