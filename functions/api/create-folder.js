// POST /api/create-folder
// 请求：{path}
// 响应：{success, path}
// 路径格式：无尾斜杠
// 实现：在 R2 中创建一个零字节占位符对象（key 以 / 结尾）以标识文件夹存在

export async function onRequestPost(context) {
  const { R2_BUCKET } = context.env
  const { request } = context

  if (!R2_BUCKET) {
    return Response.json({ error: 'R2_BUCKET not configured' }, { status: 500 })
  }

  try {
    const { path } = await request.json()

    if (!path) {
      return Response.json({ error: 'path is required' }, { status: 400 })
    }

    // 规范化路径：去除首尾空白与尾斜杠
    const normalizedPath = String(path).trim().replace(/\/+$/, '')

    if (!normalizedPath) {
      return Response.json({ error: 'path is required' }, { status: 400 })
    }

    // 禁止包含非法字符（防止路径穿越）
    if (normalizedPath.includes('..') || normalizedPath.startsWith('/')) {
      return Response.json({ error: 'Invalid path' }, { status: 400 })
    }

    // 在 R2 中创建文件夹占位符：key = path + '/'，内容为空
    const placeholderKey = normalizedPath + '/'
    await R2_BUCKET.put(placeholderKey, new ArrayBuffer(0), {
      httpMetadata: {
        contentType: 'application/x-directory'
      },
      customMetadata: {
        type: 'folder'
      }
    })

    return Response.json({
      success: true,
      path: normalizedPath
    })
  } catch (error) {
    console.error('Create folder error:', error)
    return Response.json(
      { error: 'Failed to create folder: ' + error.message },
      { status: 500 }
    )
  }
}
