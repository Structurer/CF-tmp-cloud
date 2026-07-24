// CORS 中间件：为所有 /api/* 响应添加跨域头
// 参考 API 规范：所有 API 响应头包含 access-control-allow-origin

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
}

export async function onRequest(context) {
  const { request, next } = context

  // 预检请求直接返回
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  const response = await next()

  // 为所有响应添加 CORS 头
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    response.headers.set(key, value)
  })

  return response
}
