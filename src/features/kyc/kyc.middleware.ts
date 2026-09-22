import { RequestHandler } from 'express'
import { isKycApproved } from './kyc.service'
import { env } from '../../config/env'
import { ForbiddenError } from '../../common/errors'

/**
 * Câu 403 của cổng này — CỐ ĐỊNH, vì app khớp theo chuỗi để nhận ra ca này rồi đưa người dùng
 * tới màn "hồ sơ đang chờ duyệt" thay vì hiện một thông báo lạc giữa màn họ đang đứng.
 *
 * Khớp chuỗi chứ không thêm mã lỗi vào `ApiError`: kho này đã làm đúng vậy cho `ORG_GONE_ERRORS`
 * (`app/src/api/http.ts`), và sửa hình dạng `ApiError` là đụng vào lõi — trái hẳn mục tiêu
 * "lớp phủ này gỡ ra phải gọn".
 */
export const KYC_PENDING_MESSAGE =
  'Tài khoản chưa được duyệt. Nộp hồ sơ định danh và chờ quản trị xác nhận.'

/**
 * Đường CÒN MỞ khi hồ sơ chưa được duyệt — nếu không thì người dùng không có cách nào nộp hồ
 * sơ, và cái cổng tự khoá luôn chính nó.
 *
 * Khớp theo TIỀN TỐ trên `req.path` (đã trừ `/api/v1`). Cố ý hẹp: đăng nhập/đăng xuất/làm mới
 * token, xác thực email, và đúng cụm `/kyc`. Mọi thứ khác đóng.
 */
const OPEN_PREFIXES = ['/auth', '/kyc', '/users/me']

/**
 * CỔNG KYC — tài khoản chưa được duyệt thì chưa dùng được, theo yêu cầu của Bộ Công Thương.
 *
 * ĐÂY LÀ ĐIỂM CHẠM DUY NHẤT giữa lớp phủ KYC và phần còn lại của hệ thống, và mọi quyết định
 * dưới đây phục vụ đúng một mục tiêu: gỡ nó về sau chỉ tốn một dòng.
 *
 * - KHÔNG nằm trong `auth.middleware`. Ở đó thì nó lẫn vào luồng xác thực, và gỡ ra là sửa
 *   đúng file nhạy cảm nhất của hệ thống. Ở đây nó là một `router.use` độc lập, đi kèm
 *   `optionalAuth` vì `authenticate` chạy bên trong từng feature router — không có nó thì
 *   `req.user` luôn rỗng ở tầng này và cổng cho qua tất.
 * - KHÔNG chặn KHÁCH. Không có `req.user` thì đi tiếp — người chưa đăng nhập vẫn xem được tin
 *   công khai như mọi sàn khác, và Bộ hỏi về danh tính NGƯỜI BÁN chứ không về người xem.
 * - `env.KYC_REQUIRED` tắt (mặc định) thì hàm trả về ngay ở dòng đầu. Hệ thống chạy y hệt như
 *   chưa từng có module này — đó là cách bật nó đúng giai đoạn kiểm duyệt mà không phải nín thở.
 *
 * Một lượt truy vấn nhỏ trên mỗi request đã đăng nhập là cái giá phải trả. Chấp nhận được vì
 * `kycprofiles` bé (một dòng một người), truy vấn đi thẳng vào unique index `userId`, và cờ
 * này chỉ bật trong giai đoạn cần.
 */
export const kycGate: RequestHandler = (req, res, next) => {
  // Chốt thứ hai: `features/index` đã không mount khi cờ tắt, nhưng một hàm middleware phải
  // tự đúng kể cả khi có người cắm nó chỗ khác.
  if (!env.KYC_REQUIRED) return next()

  const userId = req.user?.id
  if (!userId) return next()
  if (OPEN_PREFIXES.some((p) => req.path.startsWith(p))) return next()

  isKycApproved(userId)
    .then((ok) => next(ok ? undefined : new ForbiddenError(KYC_PENDING_MESSAGE)))
    .catch(next)
}
