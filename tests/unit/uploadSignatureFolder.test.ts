import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/config/env', () => ({
  env: {
    CLOUDINARY_CLOUD_NAME: 'ghim-prod',
    CLOUDINARY_API_KEY: 'key',
    CLOUDINARY_API_SECRET: 'secret',
    CLOUDINARY_UPLOAD_FOLDER: 'ghim',
    CLOUDINARY_UPLOAD_PRESET: 'ghim_signed',
  },
}))

import { signUploadParams, uploadService } from '../../src/features/upload/upload.service'

/**
 * Audit 4.8: chữ ký ràng vào `folder`, nên thư mục theo NGƯỜI biến vé ký thành vé "chỉ vào ngăn
 * của mình" — một người không đẩy được ảnh vào (hay đè lên) ngăn của người khác.
 */
describe('Vé ký upload — thư mục theo người xin', () => {
  it('folder = <gốc>/<userId> và chữ ký ký đúng folder đó', () => {
    const ticket = uploadService.signature('u-1')
    expect(ticket.folder).toBe('ghim/u-1')
    expect(ticket.signature).toBe(
      signUploadParams(
        { folder: 'ghim/u-1', timestamp: ticket.timestamp, upload_preset: 'ghim_signed' },
        'secret',
      ),
    )
  })

  it('hai người → hai ngăn, hai chữ ký khác nhau', () => {
    const a = uploadService.signature('u-1')
    const b = uploadService.signature('u-2')
    expect(b.folder).toBe('ghim/u-2')
    expect(a.signature).not.toBe(b.signature)
  })
})
