import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

/**
 * Danh tính CHẨN ĐOÁN của một lượt xử lý — id request, và ai/nhóm nào đang gọi.
 *
 * Tách khỏi `TenantScope` dù cả hai đều là AsyncLocalStorage, vì hai vai trò khác hẳn nhau:
 * `TenantScope` là BIÊN AN TOÀN (thiếu nó thì ném lỗi, không được đoán), còn cái này chỉ để
 * đọc log (thiếu nó thì log kém thông tin, không ai bị rò dữ liệu). Gộp vào một chỗ nghĩa là
 * job nền — vốn chạy `runUnscoped`, không có request nào — buộc phải bịa ra một scope tenant
 * chỉ để có chỗ nhét `requestId`.
 *
 * Vì sao cần: một request đi qua middleware → service → repository sinh 3-4 dòng log rời rạc.
 * Với 50 request đồng thời thì không cách nào biết dòng nào thuộc request nào. `requestId` là
 * sợi chỉ xuyên qua tất cả, và nó đi theo ngữ cảnh nên KHÔNG tầng nào phải nhận nó qua tham số.
 */
export interface RequestContext {
  requestId: string
  /** Có sau khi `authenticate` chạy — mọi log trước đó là của khách. */
  userId?: string
  /** Org đang thao tác (`X-Org-Slug`), để lọc log theo một nhóm khi họ báo lỗi. */
  orgSlug?: string
}

const storage = new AsyncLocalStorage<RequestContext>()

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore()
}

/**
 * Gắn thêm thông tin vào ngữ cảnh ĐANG chạy, bằng cách sửa tại chỗ.
 *
 * Sửa tại chỗ chứ không `storage.run` lại: danh tính chỉ biết được ở giữa chuỗi middleware
 * (`authenticate` mới đọc được token), mà `run` lại ở đó sẽ tạo một ngữ cảnh con — mọi thứ
 * chạy SONG SONG bên ngoài lời gọi đó, kể cả handler `res.on('finish')` của access log, vẫn
 * nhìn thấy ngữ cảnh cũ và log ra một request không có ai.
 */
export function enrichRequestContext(patch: Partial<Omit<RequestContext, 'requestId'>>): void {
  const ctx = storage.getStore()
  if (!ctx) return
  Object.assign(ctx, patch)
}

/** Id chỉ dùng để nối log, không phải khoá bảo mật — `randomUUID` là quá đủ. */
export function newRequestId(): string {
  return randomUUID()
}

/*
 * Id do client gửi lên chỉ được dùng khi nó VÔ HẠI: log là nơi con người đọc và là nơi hệ
 * thống thu log tách field, nên một chuỗi dài vô hạn hoặc có ký tự điều khiển là đường tiêm
 * rác vào chính công cụ điều tra sự cố. Không khớp thì lặng lẽ sinh id mới — chặn ở đây,
 * đừng trả 400 cho một header phụ trợ.
 */
const SAFE_ID = /^[\w.:-]{8,64}$/

export function sanitizeRequestId(incoming: unknown): string {
  return typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : newRequestId()
}
