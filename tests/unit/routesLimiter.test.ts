import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Mọi file routes phải gắn rate limiter (audit 7.4). Kiểm TĨNH trên mã nguồn vì đây là loại
 * thiếu sót im lặng nhất: route mới thêm không có limiter vẫn chạy đúng mọi test nghiệp vụ.
 * Router lồng trong router đã có limiter thì ghi một dòng comment "Limiter:" để nói rõ vì sao.
 */
describe('Rate limiter phủ mọi file routes', () => {
  it('không file *.routes.ts nào thiếu chữ "Limiter"', () => {
    const root = join(__dirname, '../../src/features')
    const missing: string[] = []
    for (const feature of readdirSync(root)) {
      const dir = join(root, feature)
      if (!statSync(dir).isDirectory()) continue
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.routes.ts')) continue
        if (!/Limiter/.test(readFileSync(join(dir, file), 'utf8')))
          missing.push(`${feature}/${file}`)
      }
    }
    expect(missing).toEqual([])
  })
})
