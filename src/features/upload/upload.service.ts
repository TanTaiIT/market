import { createHash } from 'node:crypto'
import { env } from '../../config/env'
import { NotImplementedError } from '../../common/errors'

/**
 * Cấp chữ ký cho MỘT lượt upload lên Cloudinary.
 *
 * Vì sao tồn tại: preset đã chuyển sang **Signed**. Upload có ký đòi ba tham số mà unsigned
 * không cần — `api_key`, `timestamp`, `signature` — và `signature` là hàm băm có `api_secret`
 * bên trong. Bundle React Native giải nén được, nên secret đó tuyệt đối không được nằm bên app;
 * chỗ duy nhất ký được là đây.
 *
 * Đổi lại, cửa upload không còn ẩn danh: muốn có chữ ký thì phải có tài khoản. Trước đây bất kỳ
 * ai đọc được bundle đều đẩy được file vào tài khoản Cloudinary này — đó chính là lỗ hổng mà
 * việc chuyển sang Signed bịt lại, và route này là nửa còn lại của việc bịt đó.
 */

export interface UploadSignature {
  cloudName: string
  apiKey: string
  /** Giây Unix. Cloudinary từ chối chữ ký lệch quá 1 giờ so với đồng hồ của nó. */
  timestamp: number
  signature: string
  /**
   * Thư mục đích, do SERVER quyết chứ không phải preset.
   *
   * Đây là một lợi ích thật của việc chuyển sang Signed: tham số gửi kèm request thắng cấu hình
   * preset, nên thư mục mà job dọn ảnh quét (`CLOUDINARY_UPLOAD_FOLDER`) và thư mục ảnh thật sự
   * rơi vào giờ là CÙNG một biến env. Trước đây chúng khớp nhau chỉ nhờ một ô cấu hình trên
   * Console mà không gì trong code kiểm được — xem `scripts/check-cloudinary.ts` mục [2].
   */
  folder: string
  uploadPreset: string
}

/**
 * Thuật toán chữ ký của Cloudinary: sắp khoá theo alphabet, nối `k=v` bằng `&`, ghép
 * `api_secret` vào đuôi, băm SHA-1.
 *
 * `file`, `api_key` và `resource_type` KHÔNG tham gia ký — Cloudinary loại chúng ra trước khi
 * đối chiếu. Ký thừa một tham số cũng hỏng y như ký thiếu, nên tập tham số ở đây phải khớp
 * chính xác tập mà app gửi lên.
 */
export function signUploadParams(
  params: Record<string, string | number>,
  apiSecret: string,
): string {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')
  return createHash('sha1')
    .update(canonical + apiSecret)
    .digest('hex')
}

export const uploadService = {
  signature(): UploadSignature {
    const {
      CLOUDINARY_CLOUD_NAME: cloudName,
      CLOUDINARY_API_KEY: apiKey,
      CLOUDINARY_API_SECRET: apiSecret,
      CLOUDINARY_UPLOAD_FOLDER: folder,
      CLOUDINARY_UPLOAD_PRESET: uploadPreset,
    } = env

    /*
     * Thiếu env thì hỏng NGAY ở đây với một câu đọc được, thay vì để app nhận 401 từ Cloudinary
     * và hiện "Tải ảnh lên thất bại" — lỗi đó trỏ vào đúng chỗ sai, còn 401 kia thì không.
     */
    if (!cloudName || !apiKey || !apiSecret) {
      throw new NotImplementedError(
        'Upload chưa dùng được: server thiếu CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET',
      )
    }

    const timestamp = Math.floor(Date.now() / 1000)
    // Ba tham số này, không hơn không kém — app phải gửi lên đúng ba cái, cùng giá trị.
    const signature = signUploadParams(
      { folder, timestamp, upload_preset: uploadPreset },
      apiSecret,
    )

    return { cloudName, apiKey, timestamp, signature, folder, uploadPreset }
  },
}
