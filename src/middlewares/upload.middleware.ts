import multer from 'multer'
import { BadRequestError } from '../common/errors'

// Lưu tạm trong memory rồi module `upload` đẩy lên S3/Cloudinary.
// KHÔNG lưu binary trong MongoDB.
const storage = multer.memoryStorage()

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const MAX_FILES = 10

export const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new BadRequestError(`Unsupported file type: ${file.mimetype}`))
    }
    cb(null, true)
  },
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
})
