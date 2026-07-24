// GET /api/list?path={path}
// 返回扁平文件数组 + 已用总容量
// 路径格式：无尾斜杠（path="" 表示根目录，path="folder/sub" 表示子目录）

export async function onRequestGet(context) {
  const { R2_BUCKET } = context.env
  const { request } = context
  const url = new URL(request.url)
  const path = url.searchParams.get('path') || ''

  if (!R2_BUCKET) {
    return Response.json({ error: 'R2_BUCKET not configured' }, { status: 500 })
  }

  try {
    // 构建 R2 list 的 prefix
    // path="" → prefix=""（根目录）
    // path="folder/sub" → prefix="folder/sub/"
    const prefix = path ? path + '/' : ''

    // 列出当前目录内容（使用 delimiter 自动分组）
    const files = []
    let cursor = null

    do {
      // 只在 cursor 有值时传入，避免 null 导致错误
      const listOpts = {
        prefix: prefix || undefined,
        delimiter: '/'
      }
      if (cursor) {
        listOpts.cursor = cursor
      }

      const result = await R2_BUCKET.list(listOpts)

      // delimitedPrefixes 是子文件夹（以 / 结尾）
      for (const dirPrefix of result.delimitedPrefixes || []) {
        const name = dirPrefix.slice(prefix.length).replace(/\/$/, '')
        if (name) {
          files.push({
            name: name,
            isDirectory: true,
            size: 0,
            uploaded: null
          })
        }
      }

      // objects 是当前目录的文件（不含子目录内容）
      for (const obj of result.objects || []) {
        // 跳过文件夹占位符（key 以 / 结尾的空对象）
        if (obj.key.endsWith('/') && obj.size === 0) {
          continue
        }
        const name = obj.key.slice(prefix.length)
        if (name && !name.includes('/')) {
          // uploaded 可能是 Date 对象或字符串，统一转为 ISO 字符串
          let uploadedIso = null
          if (obj.uploaded) {
            if (obj.uploaded instanceof Date) {
              uploadedIso = obj.uploaded.toISOString()
            } else {
              uploadedIso = new Date(obj.uploaded).toISOString()
            }
          }
          files.push({
            name: name,
            isDirectory: false,
            size: obj.size,
            uploaded: uploadedIso
          })
        }
      }

      cursor = result.cursor
    } while (cursor)

    // 计算 totalUsed：遍历所有对象累加 size
    const totalUsed = await calculateTotalUsed(R2_BUCKET)

    return Response.json({
      files: files,
      totalUsed: totalUsed
    })
  } catch (error) {
    console.error('List error:', error)
    return Response.json(
      { error: 'Failed to list files: ' + (error.message || String(error)), files: [], totalUsed: 0 },
      { status: 500 }
    )
  }
}

// 计算桶内已用总容量
async function calculateTotalUsed(bucket) {
  let total = 0
  let cursor = null

  do {
    const listOpts = {}
    if (cursor) {
      listOpts.cursor = cursor
    }

    const result = await bucket.list(listOpts)
    for (const obj of result.objects || []) {
      // 跳过文件夹占位符
      if (!(obj.key.endsWith('/') && obj.size === 0)) {
        total += obj.size
      }
    }
    cursor = result.cursor
  } while (cursor)

  return total
}
