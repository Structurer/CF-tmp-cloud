// GET /api/config
// 返回前端需要的配置项
// 仅暴露必要的信息，不暴露密码等敏感配置

import { config } from '../config.js'

export async function onRequestGet(context) {
  return Response.json({
    usePassword: !!config.USE_PASSWORD,
    capacityLimit: config.CAPACITY_LIMIT
  })
}
