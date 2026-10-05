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
  /**
   * Cận TRÊN tuổi của lượt quét theo LỨA (`mode: 'cohort'`): mỗi lượt chỉ nhìn những asset vừa
   * chạm mốc `MIN_AGE`, thay vì cả kho.
   *
   * `4d` chứ không phải `3d` dù job chạy mỗi 24 giờ, và khoảng chồng lấn đó là có chủ ý: cửa sổ
   * phải RỘNG HƠN nhịp chạy. Khít đúng một ngày thì một lượt chạy trễ một giờ — deploy, job kẹt,
   * máy chủ khởi động lại — là cả lứa hôm đó rơi ra ngoài và không lượt nào sau đó nhìn lại nữa.
   * Quét trùng một asset hai lần thì vô hại (nó chỉ được đọc), còn bỏ sót thì vĩnh viễn.
   *
   * BẤT BIẾN: khoảng `[MIN_AGE, COHORT_MAX_AGE]` phải dài hơn `IMAGE_CLEANUP_EVERY`. Giãn nhịp
   * chạy ra thì phải nới cận này theo, nếu không sẽ có lứa không ai quét.
   */
  COHORT_MAX_AGE: '4d',
  SEARCH_PAGE: 500,
  /**
   * Ngân sách thời gian cho PHA QUÉT. Thay cho trần số trang (`MAX_PAGES: 20`) đã bỏ.
   *
   * Trần số trang không phải một cái phanh mà là một cái TRẦN CỨNG, và nó làm job chết đứng ở
   * quy mô rất nhỏ. Câu truy vấn lấy mọi asset quá `MIN_AGE` — kể cả asset ĐANG ĐƯỢC DÙNG — mà
   * mỗi lượt quét lại bắt đầu từ đầu thư mục vì không có con trỏ lưu giữa các lượt. Nên khi số
   * asset quá hạn vượt 20 × 500 = 10.000, cửa sổ quét bị ảnh đang dùng lấp kín, job không còn
   * nhìn thấy tấm mồ côi nào, và dòng log "phần còn lại chờ lượt sau" thành lời hứa suông:
   * lượt sau quét đúng chỗ cũ. Với trần 12 ảnh/tin, 10.000 asset chỉ tương đương vài nghìn tin.
   *
   * Ngân sách thời gian quét TRỌN thư mục ở trường hợp thường, và chỉ dừng sớm khi kho lớn tới
   * mức một lượt không đi hết — lúc đó `scanComplete: false` nói ra điều đó thay vì im lặng.
   *
   * Phải ở DƯỚI `lockLifetime` của job (10 phút, `config/agenda.ts`) một quãng rộng: pha đọc DB
   * và pha xoá còn chạy sau pha quét, mà lock hết hạn giữa chừng là Agenda giao cùng một việc
   * cho tiến trình thứ hai. Nâng con số này thì nâng `lockLifetime` theo.
   */
  SCAN_BUDGET_MS: 5 * 60 * 1000,
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
 *
 * HÀM NÀY PHẢI RỘNG RÃI, KHÔNG ĐƯỢC KHẮT KHE — và chiều sai ở đây là chiều mất dữ liệu.
 * Nó dựng tập "còn chủ", nên một URL nó không đọc được KHÔNG bảo vệ được asset nào: asset đó
 * trông như mồ côi và bị xoá. Nhận nhầm một URL lạ chỉ khiến vài tấm rác ở lại; không nhận ra
 * một URL của chính mình là xoá mất ảnh đang hiển thị, không có đường khôi phục.
 *
 * Vì thế phải nuốt được cả URL có TRANSFORMATION (`/upload/w_800,c_limit/v123/ghim/abc.jpg`).
 * App chèn transformation vào URL để hiển thị (`displayUrl`, `squareUrl` bên RN) và hiện chỉ
 * dùng chúng trong `<Image>`, nhưng đó là một quy ước chứ không phải một hàng rào — ngày có ai
 * lưu nhầm một URL như vậy, bản cũ tách ra `w_800,c_limit/v123/ghim/abc` và tấm ảnh thật biến
 * mất sau 2 ngày, hiện ra dưới dạng "ảnh tự nhiên mất" không ai lần được.
 */
export function publicIdOf(url: string, cloudName: string): string | null {
  const match = url.match(
    new RegExp(`^https://res\\.cloudinary\\.com/${cloudName}/image/upload/(.+?)\\.[A-Za-z0-9]+$`),
  )
  if (!match) return null

  /*
   * Cắt theo đoạn VERSION, không theo hình dạng của transformation.
   *
   * Cloudinary luôn đặt `v<số>` ngay trước public_id, và transformation thì luôn đứng trước nó.
   * Nên "mọi thứ sau đoạn `v<số>` ĐẦU TIÊN" là public_id, không cần đoán đoạn nào là
   * transformation — mà đoán thì sai: một thư mục tên `e_commerce` trông y hệt một
   * transformation `e_<hiệu-ứng>`.
   *
   * Lấy đoạn `v<số>` ĐẦU TIÊN chứ không phải cuối cùng: public_id được phép chứa một thư mục
   * tên `v2`, và lấy từ cuối sẽ cắt mất phần đầu của chính public_id.
   */
  const segments = match[1].split('/')
  const version = segments.findIndex((s) => /^v\d+$/.test(s))
  // Không có đoạn version — URL viết tay hoặc dạng cũ: giữ nguyên, đừng cắt gì.
  return (version === -1 ? segments : segments.slice(version + 1)).join('/')
}

/**
 * Hai nhịp quét, và lý do phải có cả hai.
 *
 * `cohort` — nhịp THƯỜNG, chạy dày. Chỉ nhìn lứa asset vừa chạm mốc `MIN_AGE`, nên chi phí tỉ lệ
 *   với LƯỢNG UPLOAD MỖI NGÀY chứ không với kích thước kho: vài lệnh gọi API thay vì hàng trăm.
 *   Nó bắt được loại rác phổ biến nhất — ảnh upload rồi bỏ ngang form, mồ côi ngay từ đầu.
 *
 * `full` — nhịp THƯA, quét cả thư mục như trước. Bắt buộc phải còn, vì tình trạng mồ côi KHÔNG
 *   được quyết lúc upload: ảnh bị gỡ khi sửa tin, tin bị xoá mềm, người dùng đổi avatar, nhóm
 *   đổi ảnh bìa — tất cả đều biến một tấm ảnh ĐANG CÓ CHỦ thành rác nhiều tuần sau khi nó đã đi
 *   qua một lượt `cohort` sạch sẽ. Chỉ chạy `cohort` là bốn loại rác đó rò vĩnh viễn, và chúng
 *   là loại tích theo thời gian sử dụng — tức loại sẽ lớn nhất khi hệ thống đông người.
 *
 * Nói gọn: `cohort` lo rác mới, `full` lo rác phát sinh muộn. Bỏ vế nào cũng hỏng, chỉ khác là
 * bỏ `full` thì hỏng im lặng.
 */
export type SweepMode = 'cohort' | 'full'

/**
 * `full` nhìn mọi asset quá tuổi tối thiểu; `cohort` kẹp thêm cận trên để chỉ còn lứa vừa tới
 * ngưỡng. Một chỗ dựng biểu thức duy nhất — hai nhịp khác nhau đúng một mệnh đề.
 */
function expressionFor(folder: string, mode: SweepMode): string {
  const base = `folder=${folder} AND uploaded_at<${CLEANUP.MIN_AGE}`
  return mode === 'full' ? base : `${base} AND uploaded_at>${CLEANUP.COHORT_MAX_AGE}`
}

/**
 * Tuổi dạng `'2d'` ra số ngày. Hai hằng tuổi phải cùng đơn vị để so được với nhau.
 */
function ageInDays(age: string): number {
  const match = age.match(/^(\d+)d$/)
  if (!match) throw new Error(`Tuổi phải có dạng "<số>d", nhận được "${age}"`)
  return Number(match[1])
}

/*
 * Bất biến của nhịp LỨA, kiểm lúc nạp module chứ không để nằm trong một dòng chú thích.
 *
 * `COHORT_MAX_AGE <= MIN_AGE` làm biểu thức tìm kiếm thành vô nghiệm: Cloudinary trả 0 kết quả,
 * nhịp lứa lặng lẽ không quét gì, và mọi dòng log vẫn xanh. Đó đúng là kiểu hỏng mà cả đợt sửa
 * này sinh ra để chặn, nên nó không được phép tồn tại dưới dạng "nhớ đừng đặt sai".
 *
 * Ném lúc nạp module: đây là lỗi của người sửa code, không phải của người vận hành, nên nó phải
 * nổ ở lần chạy đầu tiên — kể cả trong test — chứ không đợi tới production lúc 3 giờ sáng.
 */
if (ageInDays(CLEANUP.COHORT_MAX_AGE) <= ageInDays(CLEANUP.MIN_AGE)) {
  throw new Error(
    `CLEANUP.COHORT_MAX_AGE (${CLEANUP.COHORT_MAX_AGE}) phải LỚN HƠN MIN_AGE (${CLEANUP.MIN_AGE}) — ` +
      'nếu không, nhịp quét lứa không bao giờ khớp asset nào',
  )
}

interface CleanupResult {
  scanned: number
  orphans: number
  deleted: number
  /** public_id của những asset bị coi là mồ côi — để script kiểm tra in ra soi bằng mắt. */
  orphanIds: string[]
  /**
   * Lượt này có duyệt hết thư mục không. `false` = hết ngân sách giữa chừng, phần chưa duyệt
   * nằm ngoài tầm nhìn của lượt này.
   *
   * Là một field của KẾT QUẢ chứ không chỉ một dòng log, vì đây là tín hiệu "job đang đuối so
   * với kho ảnh" — thứ phải đọc được từ `npm run check:cloudinary` chứ không phải đợi ai đó
   * tình cờ lướt qua log. Một job im lặng làm việc nửa vời là thứ khó phát hiện nhất.
   */
  scanComplete: boolean
}

/**
 * MỘT lượt dọn ảnh tại một thời điểm, bất kể nhịp nào gọi.
 *
 * `concurrency: 1` của Agenda chỉ chặn một job trùng CHÍNH NÓ. Hai nhịp ở đây là hai job khác
 * tên (`image-cleanup:sweep` và `image-cleanup:full`) nên lịch của chúng gặp nhau mỗi 7 ngày là
 * hai lượt chạy song song. Trước đây `maxConcurrency: 1` toàn cục vô tình đỡ việc này — nhưng
 * nó đỡ bằng cách xếp hàng MỌI job, kể cả `machine-review`, nên đã phải bỏ.
 *
 * Cái đắt không phải lệnh gọi API mà là BỘ NHỚ: mỗi lượt dựng một `Set` chứa public_id của mọi
 * ảnh trong DB, hai lượt song song là hai bản cùng lúc.
 *
 * Chốt trong tiến trình là đủ vì hệ thống chạy đúng một instance (adapter Socket.io in-memory,
 * xem `AGENT.md`). Ngày có nhiều instance thì chốt phải chuyển xuống DB — và lúc đó `agendaJobs`
 * đã có sẵn lock để mượn.
 */
let sweeping = false

export const uploadCleanupService = {
  /**
   * @param dryRun Tính ra danh sách mồ côi rồi DỪNG, không gọi lệnh xoá nào. `scripts/
   * check-cloudinary.ts` chạy ở chế độ này để xem job SẼ xoá gì trước khi cho nó xoá thật.
   * @param budgetMs Ghi đè `CLEANUP.SCAN_BUDGET_MS`. Có mặt để test dựng được ca "hết ngân
   * sách" bằng `0` — ca đó không tái hiện được bằng đồng hồ thật, mà nó lại là ca quyết định
   * việc job còn dọn được hay không khi kho ảnh lớn lên.
   * @param mode Xem `SweepMode`. Mặc định `full` để mọi caller cũ — và script kiểm tra — giữ
   * nguyên cái nhìn TOÀN KHO: một bản diễn tập chỉ thấy lứa mới sẽ báo "kho sạch" ngay cả khi
   * đang có cả nghìn tấm rác cũ, tức nói dối đúng lúc người ta cần sự thật nhất.
   */
  async sweep(
    cfg: CleanupConfig | null = cleanupConfigFromEnv(),
    {
      dryRun = false,
      budgetMs = CLEANUP.SCAN_BUDGET_MS,
      mode = 'full',
    }: { dryRun?: boolean; budgetMs?: number; mode?: SweepMode } = {},
  ): Promise<CleanupResult> {
    if (!cfg) {
      logger.info('image cleanup: bỏ qua — thiếu CLOUDINARY_* trong env')
      // `scanComplete: true` — không có gì để quét thì cũng không có gì bỏ sót.
      return { scanned: 0, orphans: 0, deleted: 0, orphanIds: [], scanComplete: true }
    }

    /*
     * Chặn cả `dryRun`: thứ cần bảo vệ là lượt đọc DB và cái `Set` nó dựng lên, mà diễn tập cũng
     * tốn y hệt — chỉ khác ở chỗ không xoá. `scanComplete: false` vì lượt này bỏ dở thật, nói
     * `true` là báo đã duyệt hết trong khi chưa đụng tới tấm nào.
     */
    if (sweeping) {
      logger.warn('image cleanup: bỏ qua — đã có một lượt đang chạy', { mode })
      return { scanned: 0, orphans: 0, deleted: 0, orphanIds: [], scanComplete: false }
    }
    sweeping = true
    try {
      return await runSweep(cfg, { dryRun, budgetMs, mode })
    } finally {
      sweeping = false
    }
  },
}

/** Thân thật của một lượt quét — tách ra để `sweeping` có đúng một chỗ đặt và một chỗ nhả. */
async function runSweep(
  cfg: CleanupConfig,
  { dryRun, budgetMs, mode }: { dryRun: boolean; budgetMs: number; mode: SweepMode },
): Promise<CleanupResult> {
  const { ids: stale, scanComplete } = await searchStale(cfg, budgetMs, mode)
  if (stale.length === 0) {
    return { scanned: 0, orphans: 0, deleted: 0, orphanIds: [], scanComplete }
  }

  const referenced = await referencedPublicIds(cfg.cloudName)

  /*
   * CHỐT AN TOÀN — không có nó thì một lỗi ở phía DB là mất sạch ảnh.
   *
   * `orphans` = `stale` trừ đi `referenced`. Nên nếu `referenced` rỗng vì bất kỳ lý do gì —
   * query hỏng, `MONGO_URI` trỏ nhầm sang một DB trống, `CLOUDINARY_CLOUD_NAME` lệch với
   * cloud trong URL đã lưu nên `publicIdOf` trả `null` hết — thì MỌI asset trong folder biến
   * thành mồ côi và job xoá sạch kho ảnh đang dùng. Không có đường khôi phục.
   *
   * "Kho ảnh còn hàng mà DB không tham chiếu lấy một tấm" gần như luôn là hỏng cấu hình chứ
   * không phải sự thật. Ca thật duy nhất — hệ thống mới tinh, có người upload rồi bỏ ngang mà
   * chưa ai đăng nổi một tin — chỉ khiến vài tấm rác ở lại thêm một thời gian. Đổi lấy việc
   * không bao giờ xoá nhầm toàn bộ kho, đó là cái giá rẻ.
   */
  if (referenced.size === 0) {
    logger.error('image cleanup: DỪNG — kho có ảnh nhưng DB không tham chiếu tấm nào', {
      scanned: stale.length,
    })
    return { scanned: stale.length, orphans: 0, deleted: 0, orphanIds: [], scanComplete }
  }

  const orphans = stale.filter((id) => !referenced.has(id))

  let deleted = 0
  if (!dryRun) {
    for (let i = 0; i < orphans.length; i += CLEANUP.DELETE_BATCH) {
      const batch = orphans.slice(i, i + CLEANUP.DELETE_BATCH)
      try {
        deleted += await deleteBatch(cfg, batch)
      } catch (err) {
        /*
         * Hết hạn mức ở PHA XOÁ, đối xứng với pha quét.
         *
         * Lô sau chắc chắn cũng bị từ chối, nên chạy tiếp chỉ đốt thêm hạn mức. Dừng tại đây
         * giữ lại những lô đã xoá xong; phần còn lại là mồ côi thật, lượt sau sẽ gặp lại chúng
         * vì không gì làm chúng có chủ trở lại.
         */
        if (err instanceof CloudinaryApiError && RATE_LIMITED.has(err.status)) {
          logger.warn('image cleanup: Cloudinary hết hạn mức giữa pha xoá, dừng lại', {
            deleted,
            remaining: orphans.length - i,
            status: err.status,
          })
          break
        }
        throw err
      }
    }
  }

  const result = { scanned: stale.length, orphans: orphans.length, deleted, scanComplete }
  // `mode` chỉ đi vào LOG, không vào kết quả: đọc log mà không biết lượt đó quét lứa hay quét
  // cả kho thì con số `scanned` không nói lên gì. Caller thì luôn tự biết mình gọi nhịp nào.
  logger.info(dryRun ? 'image cleanup sweep (dry-run)' : 'image cleanup sweep', {
    ...result,
    mode,
  })
  return { ...result, orphanIds: orphans }
}

/**
 * public_id của mọi asset trong folder đã sống quá MIN_AGE, gom qua cursor của Search API.
 *
 * Đi HẾT thư mục, chỉ dừng sớm khi cạn ngân sách thời gian — xem `CLEANUP.SCAN_BUDGET_MS` cho
 * lý do bỏ trần số trang.
 *
 * Dừng sớm KHÔNG làm lượt quét sai: tập mồ côi luôn là tập con của phần đã duyệt, nên mọi tấm
 * bị xoá đều thật sự không ai tham chiếu. Thứ mất đi chỉ là độ phủ, và `scanComplete` nói ra.
 */
async function searchStale(
  cfg: CleanupConfig,
  budgetMs: number,
  mode: SweepMode,
): Promise<{ ids: string[]; scanComplete: boolean }> {
  const ids: string[] = []
  const deadline = Date.now() + budgetMs
  let cursor: string | undefined

  do {
    let body: { resources: Array<{ public_id: string }>; next_cursor?: string }
    try {
      body = await cloudinaryCall(cfg, 'POST', `/resources/search`, {
        expression: expressionFor(cfg.folder, mode),
        max_results: CLEANUP.SEARCH_PAGE,
        ...(cursor ? { next_cursor: cursor } : {}),
      })
    } catch (err) {
      /*
       * Hết hạn mức Admin API KHÔNG được giết cả lượt quét.
       *
       * Số lệnh gọi mỗi lượt = tổng asset ÷ 500, nên kho càng lớn càng dễ chạm trần giờ của
       * Cloudinary. Ném ra ở đây là mất trắng cả ngày hôm đó: phần đã duyệt bị vứt đi, không
       * tấm rác nào được dọn, và job chỉ để lại một dòng lỗi. Dừng êm thì phần đã duyệt vẫn
       * được xử, đúng như khi cạn ngân sách thời gian — hai ca cùng một bản chất.
       *
       * Mọi lỗi KHÁC vẫn ném: hỏng xác thực hay sai cấu hình phải nổ to, không được lẫn vào
       * một lượt quét "thành công một phần".
       */
      if (err instanceof CloudinaryApiError && RATE_LIMITED.has(err.status)) {
        logger.warn('image cleanup: Cloudinary hết hạn mức, dừng quét sớm', {
          scannedSoFar: ids.length,
          status: err.status,
        })
        return { ids, scanComplete: false }
      }
      throw err
    }

    ids.push(...body.resources.map((r) => r.public_id))
    cursor = body.next_cursor
  } while (cursor && Date.now() < deadline)

  if (cursor) {
    // Cảnh báo này nghĩa là kho ảnh đã lớn hơn thứ một lượt quét đi hết. Nó lặp lại mỗi ngày
    // cho tới khi ai đó nâng ngân sách (kèm `lockLifetime`) hoặc chuyển sang lưu con trỏ giữa
    // các lượt — không tự khỏi.
    logger.warn('image cleanup: hết ngân sách quét, thư mục chưa duyệt hết', {
      scannedSoFar: ids.length,
      budgetMs,
    })
    return { ids, scanComplete: false }
  }
  return { ids, scanComplete: true }
}

/**
 * Mọi URL ảnh đang được DB giữ, còn NGUYÊN chuỗi — chưa qua `publicIdOf`.
 *
 * Tách khỏi `referencedPublicIds` để `scripts/check-cloudinary.ts` soi được đúng tập URL mà job
 * nhìn thấy: chốt an toàn quan trọng nhất của cả tính năng là "URL của cloud này có parse được
 * không", mà sau khi parse hỏng thì bằng chứng đã mất — `publicIdOf` trả `null` và URL bị bỏ
 * lặng lẽ khỏi tập "còn chủ".
 */
export async function allStoredImageUrls(): Promise<string[]> {
  const [listingUrls, avatarUrls, orgUrls, chatUrls] = await Promise.all([
    listingRepository.allImageRefs(),
    userRepository.allAvatars(),
    organizationRepository.allImageUrls(),
    chatRepository.allConversationAvatars(),
  ])
  return [...listingUrls, ...avatarUrls, ...orgUrls, ...chatUrls]
}

/** Mọi public_id đang có chủ trong DB — nguồn nào giữ URL ảnh thì phải có mặt ở đây. */
async function referencedPublicIds(cloudName: string): Promise<Set<string>> {
  const referenced = new Set<string>()
  for (const url of await allStoredImageUrls()) {
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

/**
 * Lỗi HTTP từ Admin API, mang theo mã trạng thái để caller phân biệt được "hết hạn mức" với
 * "hỏng thật".
 *
 * KHÔNG phải `ApiError`: nó không bao giờ đi ra tầng HTTP — đường duy nhất tới đây là job nền
 * và script chạy tay. Gói nó thành lỗi API là gán một mã HTTP cho một thứ không có request nào
 * đang chờ.
 */
export class CloudinaryApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'CloudinaryApiError'
  }
}

/**
 * Cloudinary báo hết hạn mức bằng `420` (mã cũ, vẫn còn dùng) hoặc `429`. Chặn cả hai: đoán sai
 * một mã ở đây thì lượt quét vẫn chết đúng kiểu cũ.
 */
const RATE_LIMITED = new Set([420, 429])

/** Admin API = Basic auth `api_key:api_secret` — chính vì header này mà job phải sống ở BE. */
export async function cloudinaryCall<T>(
  cfg: CleanupConfig,
  // `GET` chỉ để script kiểm tra đọc cấu hình preset và đếm asset — job không dùng tới nó.
  method: 'GET' | 'POST' | 'DELETE',
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
    throw new CloudinaryApiError(
      res.status,
      `Cloudinary ${method} ${path} → ${res.status}: ${await res.text()}`,
    )
  }
  return (await res.json()) as T
}
