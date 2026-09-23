/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
import {
  CLEANUP,
  allStoredImageUrls,
  cleanupConfigFromEnv,
  cloudinaryCall,
  publicIdOf,
  uploadCleanupService,
  type CleanupConfig,
} from '../src/features/upload/upload.cleanup.service'

/**
 * Soi cấu hình Cloudinary và DIỄN TẬP job dọn ảnh — không xoá gì, không ghi gì.
 *
 * Vì sao cần: nửa số điều kiện để job chạy đúng KHÔNG nằm trong repo này. Chúng nằm ở Cloudinary
 * Console (preset ký kiểu gì, đổ ảnh vào thư mục nào) và ở dữ liệu thật (URL đã lưu có đúng dạng
 * `publicIdOf` đọc được không). Đọc code không trả lời được, nên script này đi hỏi thẳng.
 *
 * Nó dùng ĐÚNG những hàm mà job dùng (`allStoredImageUrls`, `publicIdOf`,
 * `uploadCleanupService.sweep`), không chép lại logic — một bản chép sẽ cho sự yên tâm giả khi
 * hai bên trôi khỏi nhau.
 *
 * Chạy trước khi bật `CLOUDINARY_*` trên production, và chạy lại sau mỗi lần đổi preset.
 */

/** Preset của app RN (`docs/VueRoute/src/api/cloudinary.ts`). Đổi được qua tham số dòng lệnh. */
const PRESET = process.argv[2] ?? 'ghim_unsigned'

const CLOUDINARY_HOST = 'res.cloudinary.com'

/** Số dòng ví dụ in ra cho mỗi hạng mục — đủ để soi, không ngập màn hình. */
const SAMPLE = 10

let failures = 0
let warnings = 0

function fail(msg: string): void {
  failures += 1
  console.log(`   ❌ ${msg}`)
}
function warn(msg: string): void {
  warnings += 1
  console.log(`   ⚠️  ${msg}`)
}
function ok(msg: string): void {
  console.log(`   ✅ ${msg}`)
}

// ── 1. Thông tin đăng nhập Admin API ────────────────────────────────
async function checkCredentials(cfg: CleanupConfig): Promise<boolean> {
  console.log('\n[1] Thông tin đăng nhập Admin API')
  try {
    await cloudinaryCall(cfg, 'GET', '/resources/image/upload?max_results=1')
    ok(`gọi được Admin API của cloud "${cfg.cloudName}"`)
    return true
  } catch (err) {
    fail(`KHÔNG gọi được Admin API — ${(err as Error).message}`)
    console.log('      → sai CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET, hoặc sai cloud name.')
    return false
  }
}

// ── 2. Preset upload của app ────────────────────────────────────────
type PresetBody = {
  unsigned?: boolean
  settings?: { folder?: string; allowed_formats?: string | string[]; max_file_size?: number }
}

async function checkPreset(cfg: CleanupConfig): Promise<void> {
  console.log(`\n[2] Upload preset "${PRESET}"`)
  let body: PresetBody
  try {
    body = await cloudinaryCall<PresetBody>(cfg, 'GET', `/upload_presets/${PRESET}`)
  } catch (err) {
    fail(`không đọc được preset — ${(err as Error).message}`)
    console.log(
      '      → app RN đang upload bằng preset này; không tồn tại là mọi lượt upload hỏng.',
    )
    return
  }

  if (body.unsigned === true) ok('Signing Mode = Unsigned (app RN upload thẳng được)')
  else fail('preset KHÔNG phải unsigned — app RN không upload được ảnh nào')

  /*
   * Chốt quan trọng nhất của cả script.
   *
   * App RN không gửi tham số `folder` — thư mục đích hoàn toàn do preset quyết định. Còn job thì
   * chỉ quét `folder=<CLOUDINARY_UPLOAD_FOLDER>`. Hai giá trị này lệch nhau thì job quét một thư
   * mục rỗng và không dọn được gì, trong khi rác chất đống ở chỗ khác — im lặng, không lỗi nào.
   */
  const presetFolder = body.settings?.folder ?? ''
  if (presetFolder === cfg.folder) {
    ok(`preset đổ ảnh vào "${presetFolder}", khớp CLOUDINARY_UPLOAD_FOLDER`)
  } else if (!presetFolder) {
    fail(`preset KHÔNG đặt folder, ảnh rơi vào thư mục gốc — job chỉ quét "${cfg.folder}"`)
    console.log('      → Console → Upload presets → Folder = ' + cfg.folder)
  } else {
    fail(`preset đổ vào "${presetFolder}" nhưng job quét "${cfg.folder}" — không khớp`)
  }

  const formats = body.settings?.allowed_formats
  if (formats) ok(`allowed_formats = ${Array.isArray(formats) ? formats.join(', ') : formats}`)
  else warn('allowed_formats để trống — preset unsigned nhận cả video và file raw')

  const maxSize = body.settings?.max_file_size
  if (maxSize) ok(`max_file_size = ${(maxSize / 1024 / 1024).toFixed(1)} MB`)
  else warn('max_file_size để trống — không có trần dung lượng cho một lượt upload ẩn danh')
}

// ── 3. Kho ảnh nằm trong hay ngoài tầm quét của job ─────────────────
async function checkFolderCoverage(cfg: CleanupConfig): Promise<void> {
  console.log(`\n[3] Kho ảnh so với thư mục job quét ("${cfg.folder}")`)
  const count = async (expression: string): Promise<number> => {
    const body = await cloudinaryCall<{ total_count?: number }>(cfg, 'POST', '/resources/search', {
      expression,
      max_results: 1,
    })
    return body.total_count ?? 0
  }

  try {
    const [total, inFolder] = await Promise.all([
      count('resource_type:image'),
      count(`folder=${cfg.folder}`),
    ])
    const outside = total - inFolder
    console.log(`   · tổng ảnh trong tài khoản: ${total}`)
    console.log(`   · nằm trong "${cfg.folder}":  ${inFolder}`)

    if (total === 0) warn('tài khoản chưa có ảnh nào — chưa kết luận được gì về thư mục')
    else if (outside <= 0) ok('mọi ảnh đều nằm trong tầm quét của job')
    else warn(`${outside} ảnh nằm NGOÀI "${cfg.folder}" — job mù với chúng, rác ở đó không ai dọn`)
  } catch (err) {
    fail(`không đếm được — ${(err as Error).message}`)
  }
}

// ── 4. URL đã lưu có parse ngược ra public_id được không ────────────
/**
 * Đây là chốt AN TOÀN, không phải chốt hiệu quả.
 *
 * Job coi "mồ côi" = có trên cloud nhưng không có trong tập URL của DB. Một URL thuộc cloud này
 * mà `publicIdOf` không đọc nổi sẽ bị bỏ lặng lẽ khỏi tập đó — và asset đang được dùng thật biến
 * thành ứng viên bị xoá. Hỏng theo hướng mất dữ liệu, không có đường khôi phục.
 */
async function checkUrlParsing(cfg: CleanupConfig): Promise<void> {
  console.log('\n[4] URL ảnh trong DB có parse ra public_id được không')

  const urls = (await allStoredImageUrls()).filter(Boolean)
  const thisCloud: string[] = []
  const otherCloud: string[] = []
  const foreign: string[] = []
  const unparsable: string[] = []

  for (const url of urls) {
    let host: string
    let path: string
    try {
      const parsed = new URL(url)
      host = parsed.host
      path = parsed.pathname
    } catch {
      foreign.push(url)
      continue
    }

    if (host !== CLOUDINARY_HOST) {
      foreign.push(url)
    } else if (!path.startsWith(`/${cfg.cloudName}/`)) {
      otherCloud.push(url)
    } else {
      thisCloud.push(url)
      if (publicIdOf(url, cfg.cloudName) === null) unparsable.push(url)
    }
  }

  console.log(`   · tổng URL ảnh trong DB: ${urls.length}`)
  console.log(`   · thuộc cloud "${cfg.cloudName}": ${thisCloud.length}`)
  if (foreign.length > 0) {
    console.log(`   · host khác (avatar Google, ảnh seed…): ${foreign.length} — job không đụng tới`)
  }

  if (otherCloud.length > 0) {
    warn(`${otherCloud.length} URL trỏ sang cloud Cloudinary KHÁC — job không quản được chúng`)
    otherCloud.slice(0, SAMPLE).forEach((u) => console.log(`        ${u}`))
  }

  if (unparsable.length === 0) {
    ok(`cả ${thisCloud.length} URL của cloud này đều đọc ra public_id`)
  } else {
    fail(`${unparsable.length} URL KHÔNG parse được — job sẽ coi ảnh đang dùng là rác và xoá`)
    unparsable.slice(0, SAMPLE).forEach((u) => console.log(`        ${u}`))
    console.log('      → thường do URL đã lưu kèm transform (`/upload/w_800,.../`).')
    console.log('        Sửa `publicIdOf` để bỏ qua đoạn transform TRƯỚC khi bật job.')
  }
}

// ── 5. Diễn tập: job sẽ xoá đúng những gì ───────────────────────────
async function dryRun(cfg: CleanupConfig): Promise<void> {
  console.log(`\n[5] Diễn tập (ảnh cũ hơn ${CLEANUP.MIN_AGE}, KHÔNG xoá gì)`)
  const res = await uploadCleanupService.sweep(cfg, { dryRun: true })

  console.log(`   · asset đủ tuổi bị xét: ${res.scanned}`)
  console.log(`   · sẽ bị xoá:            ${res.orphans}`)

  if (res.scanned === 0) {
    warn('không có asset nào đủ tuổi — chưa diễn tập được, chạy lại sau vài ngày')
    return
  }
  if (res.orphans === 0) {
    ok('không có ảnh mồ côi nào — kho sạch')
    return
  }

  res.orphanIds.slice(0, SAMPLE).forEach((id) => console.log(`        ${id}`))
  if (res.orphanIds.length > SAMPLE) {
    console.log(`        … và ${res.orphanIds.length - SAMPLE} tấm nữa`)
  }

  /*
   * Tỉ lệ cao không tự nó là lỗi — hệ thống mới thì phần lớn kho ĐÚNG là rác. Nhưng nó cũng là
   * hình dạng của một cấu hình hỏng, nên bắt người chạy nhìn vào danh sách trên trước khi bật.
   */
  const ratio = res.orphans / res.scanned
  if (ratio > 0.5) {
    warn(`${(ratio * 100).toFixed(0)}% kho sẽ bị xoá — soi danh sách trên trước khi bật job`)
  } else {
    ok(`${(ratio * 100).toFixed(0)}% kho là rác, tỉ lệ hợp lý`)
  }
}

async function main(): Promise<void> {
  const cfg = cleanupConfigFromEnv()
  console.log(`▶ NODE_ENV=${env.NODE_ENV} · preset="${PRESET}"`)

  if (!cfg) {
    console.log('\n❌ Thiếu CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET trong env.')
    console.log('   Job dọn ảnh hiện KHÔNG được đăng ký và không chạy lượt nào.')
    process.exit(1)
  }

  await mongoose.connect(env.MONGO_URI)
  console.log(`▶ db "${mongoose.connection.name}"`)

  try {
    // Sai thông tin đăng nhập thì bốn bước sau chỉ ném cùng một lỗi — dừng sớm cho gọn output.
    if (await checkCredentials(cfg)) {
      await checkPreset(cfg)
      await checkFolderCoverage(cfg)
      await checkUrlParsing(cfg)
      await dryRun(cfg)
    }
  } finally {
    await mongoose.disconnect()
  }

  console.log('\n' + '─'.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} lỗi, ${warnings} cảnh báo — ĐỪNG bật job cho tới khi hết lỗi.`)
  } else if (warnings > 0) {
    console.log(`⚠️  0 lỗi, ${warnings} cảnh báo — bật được, đọc cảnh báo ở trên trước.`)
  } else {
    console.log('✅ Cấu hình Cloudinary ổn, job chạy được.')
  }
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
