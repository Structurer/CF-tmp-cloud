// POST /api/delete
// 请求：{path, isDirectory}
// 响应：{success, deleted}
// 路径格式：无尾斜杠
// 幂等：删除不存在的文件也返回 success

export async function onRequestPost(context) {
  const { R2_BUCKET } = context.env
  const { request } = context

  if (!R2_BUCKET) {
    return Response.json({ error: 'R2_BUCKET not configured' }, { status: 500 })
  }

  try {
    const { path, isDirectory } = await request.json()

    if (!path) {
      return Response.json({ error: 'path is required' }, { status: 400 })
    }

    let deletedCount = 0

    if (isDirectory) {
      // 文件夹：递归删除所有以 path + '/' 为前缀的对象
      const prefix = path + '/'
      let cursor = null

      do {
        const listOpts = { prefix: prefix }
        if (cursor) {
          listOpts.cursor = cursor
        }
        const result = await R2_BUCKET.list(listOpts)

        for (const obj of result.objects || []) {
          await R2_BUCKET.delete(obj.key)
          deletedCount++
        }

        cursor = result.cursor
      } while (cursor)

      // 删除文件夹占位符（如果有）
      try {
        await R2_BUCKET.delete(path + '/')
        deletedCount++
      } catch {
        // 占位符可能不存在，忽略错误
      }
    } else {
      // 单个文件：直接删除
      await R2_BUCKET.delete(path)
      deletedCount = 1
    }

    return Response.json({
      success: true,
      deleted: deletedCount
    })
  } catch (error) {
    console.error('Delete error:', error)
    return Response.json(
      { error: 'Failed to delete: ' + error.message },
      { status: 500 }
    )
  }
}
