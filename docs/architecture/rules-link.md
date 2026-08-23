# Bậc uy tín người bán — bản giải thích cho người không rành kỹ thuật

Mô tả cách hệ thống xếp bậc uy tín và quyết định tin nào phải qua người duyệt. Nguồn sự thật
vẫn là code (`src/features/trust/`, `src/features/listing/listing.quota.ts`); trang này chỉ
diễn giải, cập nhật lại khi ngưỡng đổi.

https://claude.ai/code/artifact/7649615f-edbb-4092-b411-665d67b9cc4e

Bản này thay cho `ad4a9daa-9210-411b-8794-8d238e87d05f` — bản cũ có trước ba thay đổi ngưỡng:
trần bậc `MAX_TRUST_LEVEL = 2`, `PENALIZED_LIMIT` 1 → 2, và tách mức độ từ chối
(`quality` / `violation`), nên nó nói sai cái giá của một lượt bị từ chối.
