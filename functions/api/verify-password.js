// POST /api/verify-password
// 请求：{password}
// 响应：
//   200 → {success: true}（密码正确）
//   401 → {error: "密码错误"}（密码错误）
//   403 → {error: "未启用密码保护"}（USE_PASSWORD = false）
//   403 → {error: "已启用密码保护，但未配置 PASSWORD 环境变量"}（USE_PASSWORD = true 但未配置）
// 触发条件：当 totalUsed + newFilesSize > 10GB 且 USE_PASSWORD = true 时，前端弹出密码验证框
// 密码来源：环境变量 PASSWORD

import { config } from '../config.js'

export async function onRequestPost(context) {
  const { request, env } = context

  try {
    // 未启用密码保护 → 不需要验证密码
    if (!config.USE_PASSWORD) {
      return Response.json(
        { error: '未启用密码保护' },
        { status: 403 }
      )
    }

    // 启用密码保护但未配置 PASSWORD → 报错
    const configuredPassword = env.PASSWORD || ''
    if (!configuredPassword) {
      return Response.json(
        { error: '已启用密码保护，但未配置 PASSWORD 环境变量' },
        { status: 403 }
      )
    }

    const { password } = await request.json()

    // 校验密码（恒定时间比较，避免时序攻击）
    const userInput = String(password || '')
    if (userInput.length !== configuredPassword.length) {
      return Response.json({ error: '密码错误' }, { status: 401 })
    }

    let diff = 0
    for (let i = 0; i < userInput.length; i++) {
      diff |= userInput.charCodeAt(i) ^ configuredPassword.charCodeAt(i)
    }

    if (diff !== 0) {
      return Response.json({ error: '密码错误' }, { status: 401 })
    }

    return Response.json({ success: true })
  } catch (error) {
    console.error('Verify password error:', error)
    return Response.json(
      { error: 'Failed to verify password: ' + error.message },
      { status: 500 }
    )
  }
}
