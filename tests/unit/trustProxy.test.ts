import { describe, it, expect } from 'vitest'

/*
 * `TRUST_PROXY` phải đi tới `app.set('trust proxy')` — thiếu dòng đó thì sau Render/LB mọi người
 * dùng chung một `req.ip`, và rate limit đăng nhập gom cả sàn vào một xô. Đặt env TRƯỚC khi
 * import app: `env` đóng băng lúc import, và vitest cô lập module theo từng file test.
 */
process.env.TRUST_PROXY = '1'

describe('trust proxy', () => {
  it('nạp từ env vào express — tin đúng một hop proxy', async () => {
    const { createApp } = await import('../../src/app')
    const app = createApp()

    expect(app.get('trust proxy')).toBe(1)

    // Hàm express biên dịch từ giá trị đó: hop 0 (proxy ngay trước server) được tin, hop 1 không.
    const trust = app.get('trust proxy fn') as (addr: string, hop: number) => boolean
    expect(trust('10.0.0.1', 0)).toBe(true)
    expect(trust('10.0.0.1', 1)).toBe(false)
  })
})
