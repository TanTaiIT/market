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

  /*
   * Nhóm ca NGUY HIỂM NHẤT: URL mang transformation.
   *
   * App chèn transformation để hiển thị (`displayUrl`, `squareUrl` bên RN). Bản cũ của hàm này
   * tách `/upload/w_800,c_limit/v1/ghim/abc.jpg` ra thành `w_800,c_limit/v1/ghim/abc` — một
   * public_id không tồn tại. Hệ quả không phải một lỗi ồn ào mà là một tấm ảnh ĐANG HIỂN THỊ
   * rơi khỏi tập "còn chủ", thành mồ côi giả, và bị xoá sau 2 ngày.
   */
  it('URL có transformation vẫn ra public_id GỐC, không phải một id bịa', () => {
    expect(
      publicIdOf(
        `https://res.cloudinary.com/${CLOUD}/image/upload/w_800,c_limit,q_auto,f_auto/v1724300000/ghim/abc123.jpg`,
        CLOUD,
      ),
    ).toBe('ghim/abc123')
  })

  it('transformation nối nhiều đoạn cũng vậy', () => {
    expect(
      publicIdOf(
        `https://res.cloudinary.com/${CLOUD}/image/upload/c_fill,w_200,h_200,g_auto/e_grayscale/v1/ghim/abc.jpg`,
        CLOUD,
      ),
    ).toBe('ghim/abc')
  })

  /*
   * Hai ca dưới neo lý do cắt theo ĐOẠN VERSION thay vì theo hình dạng của transformation —
   * đoán hình dạng thì cả hai đều sai.
   */
  it('thư mục trông giống transformation KHÔNG bị cắt nhầm', () => {
    expect(
      publicIdOf(`https://res.cloudinary.com/${CLOUD}/image/upload/v1/e_commerce/abc.jpg`, CLOUD),
    ).toBe('e_commerce/abc')
  })

  it('thư mục tên `v2` nằm trong public_id được giữ nguyên', () => {
    expect(
      publicIdOf(
        `https://res.cloudinary.com/${CLOUD}/image/upload/v1724300000/ghim/v2/abc.jpg`,
        CLOUD,
      ),
    ).toBe('ghim/v2/abc')
  })
})
