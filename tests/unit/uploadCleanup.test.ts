import { describe, it, expect } from 'vitest'
import { publicIdOf } from '../../src/features/upload/upload.cleanup.service'

const CLOUD = 'ds4dqc7s5'

describe('Dọn ảnh mồ côi — nhận diện public_id', () => {
  it('URL chuẩn của upload (có version, có folder) ra đúng public_id kèm folder', () => {
    expect(
      publicIdOf(
        `https://res.cloudinary.com/${CLOUD}/image/upload/v1724300000/ghim/abc123.jpg`,
        CLOUD,
      ),
    ).toBe('ghim/abc123')
  })

  it('URL không version vẫn nhận được', () => {
    expect(publicIdOf(`https://res.cloudinary.com/${CLOUD}/image/upload/ghim/x.webp`, CLOUD)).toBe(
      'ghim/x',
    )
  })

  it('URL ngoài cloud này trả null — job không có thẩm quyền với chúng', () => {
    expect(publicIdOf('https://example.com/a.jpg', CLOUD)).toBeNull()
    expect(
      publicIdOf('https://res.cloudinary.com/cloud-khac/image/upload/v1/ghim/a.jpg', CLOUD),
    ).toBeNull()
  })

  it('chuỗi rỗng (avatar chưa đặt) trả null thay vì nổ', () => {
    expect(publicIdOf('', CLOUD)).toBeNull()
  })
})
