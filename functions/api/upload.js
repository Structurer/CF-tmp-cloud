// POST /api/upload
// 两种模式：
//   1. 直传（小文件）：POST /api/upload?path={path}，请求体为 raw binary
//   2. 分片上传（大文件）：
//      - init:    POST /api/upload，JSON {action:"init", path, fileSize, contentType} → {uploadId, chunkSize, totalParts}
//      - part:    POST /api/upload?path=&uploadId=&partNumber=，raw binary → {etag}
//      - complete: POST /api/upload，JSON {action:"complete", path, uploadId, parts} → {success}
//      - abort:   POST /api/upload，JSON {action:"abort", path, uploadId} → {success}
//
// 容量与密码策略（由 functions/config.js 的 USE_PASSWORD 控制）：
//   USE_PASSWORD = false:
//     - 无需密码即可上传
//     - totalUsed + fileSize 必须 ≤ 10GB，超限直接拒绝
//   USE_PASSWORD = true:
//     - 必须配置 PASSWORD 环境变量，否则禁止上传
//     - totalUsed + fileSize ≤ 10GB → 允许上传
//     - totalUsed + fileSize >  10GB → 需要 X-Upload-Password header 验证密码

import { config } from '../config.js'

const CHUNK_SIZE = 10 * 1024 * 1024 // 10MB
const CAPACITY_LIMIT = config.CAPACITY_LIMIT // 从 config 读取

export async function onRequestPost(context) {
  const { request, env } = context
  const { R2_BUCKET } = env

  if (!R2_BUCKET) {
    return Response.json({ error: 'R2_BUCKET not configured' }, { status: 500 })
  }

  try {
    // 1. 密码模式检查
    if (config.USE_PASSWORD) {
      // 启用密码保护：必须配置 PASSWORD 环境变量
      if (!env.PASSWORD) {
        return Response.json(
          { error: '已启用密码保护，但未配置 PASSWORD 环境变量' },
          { status: 403 }
        )
      }
    }
    // USE_PASSWORD = false 时不检查密码，直接放行（后续容量检查会处理）

    const url = new URL(request.url)
    const contentType = request.headers.get('content-type') || ''
    const path = url.searchParams.get('path') || ''
    const uploadId = url.searchParams.get('uploadId')
    const partNumber = url.searchParams.get('partNumber')

    // 情况 1：JSON 请求 → 分片上传的 init/complete/abort
    if (contentType.includes('application/json')) {
      const body = await request.json()
      const action = body.action

      if (action === 'init') {
        return await handleInit(R2_BUCKET, env, body, request)
      } else if (action === 'complete') {
        return await handleComplete(R2_BUCKET, body)
      } else if (action === 'abort') {
        return await handleAbort(R2_BUCKET, body)
      } else {
        return Response.json({ error: 'Unknown action: ' + action }, { status: 400 })
      }
    }

    // 情况 2：有 uploadId 和 partNumber → 分片上传 part（init 已验证过容量和密码）
    if (uploadId && partNumber) {
      return await handleUploadPart(R2_BUCKET, path, uploadId, parseInt(partNumber, 10), request)
    }

    // 情况 3：有 path 但无 uploadId → 直传小文件
    if (path) {
      return await handleDirectUpload(R2_BUCKET, env, path, request)
    }

    return Response.json({ error: 'Invalid upload request' }, { status: 400 })
  } catch (error) {
    console.error('Upload error:', error)
    return Response.json(
      { error: 'Failed to upload: ' + error.message },
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

// 验证密码（恒定时间比较）
function verifyPassword(env, password) {
  const configuredPassword = env.PASSWORD || ''
  if (!configuredPassword) return false

  const userInput = String(password || '')
  if (userInput.length !== configuredPassword.length) return false

  let diff = 0
  for (let i = 0; i < userInput.length; i++) {
    diff |= userInput.charCodeAt(i) ^ configuredPassword.charCodeAt(i)
  }
  return diff === 0
}

// 检查容量和密码
// 返回 {allowed: true} 或 {allowed: false, response: Response}
async function checkCapacityAndAuth(bucket, env, fileSize, request) {
  const totalUsed = await calculateTotalUsed(bucket)

  // 容量未超限 → 允许
  if (totalUsed + fileSize <= CAPACITY_LIMIT) {
    return { allowed: true }
  }

  // 容量超限
  if (config.USE_PASSWORD) {
    // 启用密码保护：超限后允许通过密码验证继续上传
    const password = request.headers.get('X-Upload-Password')
    if (!verifyPassword(env, password)) {
      return {
        allowed: false,
        response: Response.json(
          {
            error: '容量超限，需要密码验证',
            totalUsed: totalUsed,
            fileSize: fileSize,
            limit: CAPACITY_LIMIT
          },
          { status: 401 }
        )
      }
    }
    return { allowed: true }
  } else {
    // 未启用密码保护：超限直接拒绝
    return {
      allowed: false,
      response: Response.json(
        {
          error: '容量超限，已达到 10GB 上限',
          totalUsed: totalUsed,
          fileSize: fileSize,
          limit: CAPACITY_LIMIT
        },
        { status: 413 }
      )
    }
  }
}

// 分片上传 - 初始化
// 请求：{action:"init", path, fileSize, contentType}
// 响应：{uploadId, chunkSize, totalParts}
async function handleInit(bucket, env, body, request) {
  const { path: filePath, fileSize, contentType: fileContentType } = body

  if (!filePath) {
    return Response.json({ error: 'path is required' }, { status: 400 })
  }

  // 容量与密码检查
  const check = await checkCapacityAndAuth(bucket, env, fileSize || 0, request)
  if (!check.allowed) {
    return check.response
  }

  // 创建 R2 分片上传
  const multipart = await bucket.createMultipartUpload(filePath, {
    httpMetadata: {
      contentType: fileContentType || 'application/octet-stream'
    }
  })

  return Response.json({
    uploadId: multipart.uploadId,
    chunkSize: CHUNK_SIZE,
    totalParts: Math.ceil(fileSize / CHUNK_SIZE)
  })
}

// 分片上传 - 上传单个分片
// 请求：?path=&uploadId=&partNumber=，raw binary
// 响应：{etag}
async function handleUploadPart(bucket, path, uploadId, partNumber, request) {
  if (!path || !uploadId || !partNumber) {
    return Response.json({ error: 'path, uploadId, partNumber are required' }, { status: 400 })
  }

  // 恢复分片上传会话
  const multipart = bucket.resumeMultipartUpload(path, uploadId)

  // 读取分片数据
  const data = await request.arrayBuffer()

  // 上传分片
  const result = await multipart.uploadPart(partNumber, data)

  return Response.json({
    etag: result.etag
  })
}

// 分片上传 - 完成
// 请求：{action:"complete", path, uploadId, parts:[{partNumber, etag, size}]}
// 响应：{success:true}
async function handleComplete(bucket, body) {
  const { path: filePath, uploadId, parts } = body

  if (!filePath || !uploadId || !parts) {
    return Response.json({ error: 'path, uploadId, parts are required' }, { status: 400 })
  }

  // 恢复分片上传会话
  const multipart = bucket.resumeMultipartUpload(filePath, uploadId)

  // R2 complete 需要 [{partNumber, etag}] 格式
  const uploadedParts = parts
    .sort((a, b) => a.partNumber - b.partNumber)
    .map(p => ({
      partNumber: p.partNumber,
      etag: p.etag
    }))

  // 完成分片上传
  await multipart.complete(uploadedParts)

  return Response.json({ success: true })
}

// 分片上传 - 取消
// 请求：{action:"abort", path, uploadId}
// 响应：{success:true}
async function handleAbort(bucket, body) {
  const { path: filePath, uploadId } = body

  if (!filePath || !uploadId) {
    return Response.json({ error: 'path, uploadId are required' }, { status: 400 })
  }

  // 恢复分片上传会话并取消
  const multipart = bucket.resumeMultipartUpload(filePath, uploadId)
  await multipart.abort()

  return Response.json({ success: true })
}

// 直传小文件
// 请求：?path={path}，raw binary
// 响应：{success:true, path}
async function handleDirectUpload(bucket, env, path, request) {
  // 从 content-length 获取文件大小
  const fileSize = parseInt(request.headers.get('content-length') || '0', 10)

  // 容量与密码检查
  const check = await checkCapacityAndAuth(bucket, env, fileSize, request)
  if (!check.allowed) {
    return check.response
  }

  // 读取文件内容
  const data = await request.arrayBuffer()
  const contentType = request.headers.get('content-type') || 'application/octet-stream'

  // 直接 put 到 R2
  await bucket.put(path, data, {
    httpMetadata: {
      contentType: contentType
    }
  })

  return Response.json({
    success: true,
    path: path
  })
}
