import { env } from '../../config/env'
import { logger } from '../../config/logger'
import { listingRepository } from '../listing/listing.repository'
import { userRepository } from '../user/user.repository'
import { organizationRepository } from '../organization/organization.repository'
import { chatRepository } from '../chat/chat.repository'

/**
 * Job dọn ảnh mồ côi trên Cloudinary.
 *
 * Vì sao tồn tại: FE upload ảnh NGAY lúc người dùng chọn (đúng UX — nút Đăng không phải chờ),
 * nên lúc họ gỡ ảnh khỏi form hay bỏ ngang, asset đã nằm trên cloud mà không tin nào tham
 * chiếu. FE không tự dọn được về nguyên tắc — xoá cần `api_secret`, thứ không được nằm trong
 * bundle RN. Vậy dọn là việc của BE, nơi secret ở đúng chỗ của nó.
 *
 * Luật an toàn, theo thứ tự quan trọng:
 * 1. CHỈ quét trong folder cấu hình — ngoài ranh giới đó job mù, không xoá gì.
 * 2. CHỈ xét asset đã sống quá `MIN_AGE` — form đang mở dở không bao giờ bị giật ảnh.
 * 3. "Còn chủ" = URL xuất hiện ở BẤT KỲ đâu trong DB: ảnh tin + snapshot avatar người đăng,
 *    avatar user, avatar/cover org, avatar hội thoại chat. Nghi ngờ thì GIỮ, không xoá.
 *
 * Tin xoá mềm cố ý KHÔNG được tính là chủ: không có đường khôi phục tin, nên ảnh của nó là
 * rác đúng nghĩa — sẽ được dọn ở lượt quét sau khi ảnh đủ tuổi.
 *
 * REST thuần qua `fetch` (Node 20) thay vì SDK `cloudinary`: chỉ cần 2 endpoint Admin API,
 * không đáng một dependency mới.
 */
export const CLEANUP = {
  /** Tuổi tối thiểu trước khi một asset bị xét — cú pháp thời-gian-tương-đối của Search API. */
  MIN_AGE: '2d',
  SEARCH_PAGE: 500,
  /** Trần số trang mỗi lượt — chặn một lượt quét chạy mãi khi kho ảnh phình bất thường. */
  MAX_PAGES: 20,
  /** Admin API nhận tối đa 100 public_id mỗi lệnh xoá. */
  DELETE_BATCH: 100,
} as const

export interface CleanupConfig {
  cloudName: string
  apiKey: string
  apiSecret: string
  folder: string
}

/** `null` = chưa cấu hình Cloudinary — job tự tắt, không phải lỗi. */
export function cleanupConfigFromEnv(): CleanupConfig | null {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = env
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) return null
  return {
    cloudName: CLOUDINARY_CLOUD_NAME,
    apiKey: CLOUDINARY_API_KEY,
    apiSecret: CLOUDINARY_API_SECRET,
    folder: env.CLOUDINARY_UPLOAD_FOLDER,
  }
}

/**
 * public_id từ một secure_url dạng lưu trữ (`.../image/upload/v123/ghim/abc.jpg` → `ghim/abc`).
 * URL không thuộc cloud này (ảnh seed `example.com`, host ngoài…) → `null` — job không có
 * thẩm quyền gì với chúng.
 */
export function publicIdOf(url: string, cloudName: string): string | null {
  const match = url.match(
    new RegExp(
      `^https://res\\.cloudinary\\.com/${cloudName}/image/upload/(?:v\\d+/)?(.+?)\\.[A-Za-z0-9]+$`,
    ),
  )
  return match ? match[1] : null
}

interface CleanupResult {
  scanned: number
  orphans: number
  deleted: number
}

export const uploadCleanupService = {
  async sweep(cfg: CleanupConfig | null = cleanupConfigFromEnv()): Promise<CleanupResult> {
    if (!cfg) {
      logger.info('image cleanup: bỏ qua — thiếu CLOUDINARY_* trong env')
      return { scanned: 0, orphans: 0, deleted: 0 }
    }

    const stale = await searchStale(cfg)
    if (stale.length === 0) return { scanned: 0, orphans: 0, deleted: 0 }

    const referenced = await referencedPublicIds(cfg.cloudName)
    const orphans = stale.filter((id) => !referenced.has(id))

    let deleted = 0
    for (let i = 0; i < orphans.length; i += CLEANUP.DELETE_BATCH) {
      deleted += await deleteBatch(cfg, orphans.slice(i, i + CLEANUP.DELETE_BATCH))
    }

    const result = { scanned: stale.length, orphans: orphans.length, deleted }
    logger.info('image cleanup sweep', { ...result })
    return result
  },
}

/** public_id của mọi asset trong folder đã sống quá MIN_AGE, gom qua cursor của Search API. */
async function searchStale(cfg: CleanupConfig): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined

  for (let page = 0; page < CLEANUP.MAX_PAGES; page += 1) {
    const body = await cloudinaryCall<{
      resources: Array<{ public_id: string }>
      next_cursor?: string
    }>(cfg, 'POST', `/resources/search`, {
      expression: `folder=${cfg.folder} AND uploaded_at<${CLEANUP.MIN_AGE}`,
      max_results: CLEANUP.SEARCH_PAGE,
      ...(cursor ? { next_cursor: cursor } : {}),
    })

    ids.push(...body.resources.map((r) => r.public_id))
    cursor = body.next_cursor
    if (!cursor) return ids
  }

  // Chạm trần trang: phần còn lại chờ lượt quét sau — nói ra, đừng im lặng bỏ dở (no silent cap).
  logger.warn('image cleanup: chạm trần MAX_PAGES, phần còn lại chờ lượt sau', {
    scannedSoFar: ids.length,
  })
  return ids
}

/** Mọi public_id đang có chủ trong DB — nguồn nào giữ URL ảnh thì phải có mặt ở đây. */
async function referencedPublicIds(cloudName: string): Promise<Set<string>> {
  const [listingUrls, avatarUrls, orgUrls, chatUrls] = await Promise.all([
    listingRepository.allImageRefs(),
    userRepository.allAvatars(),
    organizationRepository.allImageUrls(),
    chatRepository.allConversationAvatars(),
  ])

  const referenced = new Set<string>()
  for (const url of [...listingUrls, ...avatarUrls, ...orgUrls, ...chatUrls]) {
    const id = publicIdOf(url, cloudName)
    if (id) referenced.add(id)
  }
  return referenced
}

async function deleteBatch(cfg: CleanupConfig, publicIds: string[]): Promise<number> {
  if (publicIds.length === 0) return 0
  const query = publicIds.map((id) => `public_ids[]=${encodeURIComponent(id)}`).join('&')
  const body = await cloudinaryCall<{ deleted: Record<string, string> }>(
    cfg,
    'DELETE',
    `/resources/image/upload?${query}`,
  )
  return Object.values(body.deleted).filter((state) => state === 'deleted').length
}

/** Admin API = Basic auth `api_key:api_secret` — chính vì header này mà job phải sống ở BE. */
async function cloudinaryCall<T>(
  cfg: CleanupConfig,
  method: 'POST' | 'DELETE',
  path: string,
  jsonBody?: unknown,
): Promise<T> {
  const auth = Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString('base64')
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      ...(jsonBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(jsonBody ? { body: JSON.stringify(jsonBody) } : {}),
  })
  if (!res.ok) {
    throw new Error(`Cloudinary ${method} ${path} → ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as T
}
