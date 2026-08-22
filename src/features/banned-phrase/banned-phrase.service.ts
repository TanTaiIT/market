import { Types } from 'mongoose'
import { bannedPhraseRepository } from './banned-phrase.repository'
import { CreateBannedPhraseInput } from './banned-phrase.schema'
import { ConflictError, NotFoundError } from '../../common/errors'
import { logger } from '../../config/logger'

/**
 * Cache in-memory cho đường NÓNG: `bannedPhraseIn` chạy trong MỌI lượt đăng/sửa tin và mỗi
 * lượt quét của máy — không được trả giá một query cho mỗi lần so chuỗi.
 *
 * Ghi qua service này xoá cache ngay nên trên MỘT instance (deploy hiện tại) luật mới áp tức
 * thì; TTL là lưới an toàn cho ngày chạy nhiều instance — cụm cấm mới trễ tối đa 60 giây trên
 * instance khác, chấp nhận được với một danh sách đổi vài lần mỗi tháng.
 */
const CACHE_TTL_MS = 60_000
let cache: { phrases: string[]; loadedAt: number } | null = null

export const bannedPhraseService = {
  /** Bản chữ cho các điểm so khớp (cổng đăng/sửa, máy quét) — đi qua cache. */
  async phrases(): Promise<string[]> {
    if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.phrases
    const phrases = await bannedPhraseRepository.allPhrases()
    cache = { phrases, loadedAt: Date.now() }
    return phrases
  },

  /** Bản đầy đủ cho màn quản trị của master — không cache, màn này lạnh. */
  list() {
    return bannedPhraseRepository.listAll()
  },

  async create(input: CreateBannedPhraseInput, actorId: string) {
    try {
      const row = await bannedPhraseRepository.create(input.phrase, new Types.ObjectId(actorId))
      cache = null
      logger.info('banned phrase added', { actorId, phrase: input.phrase })
      return row
    } catch (err) {
      // Trùng cụm là 409 đọc được, không phải 500: unique index là người phán, không cần
      // pre-check để rồi vẫn phải xử race y hệt ở đây.
      if (err instanceof Error && 'code' in err && err.code === 11000) {
        throw new ConflictError('Cụm này đã có trong danh sách cấm')
      }
      throw err
    }
  },

  async remove(id: string, actorId: string) {
    const row = await bannedPhraseRepository.deleteById(id)
    if (!row) throw new NotFoundError('Không tìm thấy cụm cấm này')
    cache = null
    logger.info('banned phrase removed', { actorId, phrase: row.phrase })
    return row
  },
}
