# 吵架包赢

一个基于 Next.js 与 TypeScript 的对话回击生成器，根据对方的话和语气强度，调用 OpenRouter 上的 `deepseek/deepseek-chat-v3.1:free` 模型生成三条高能反击。

## 本地运行

1. 安装依赖：
   ```bash
   npm install
   ```
2. 复制 `.env.local.example` 为 `.env.local`，填入你的 OpenRouter API Key：
   ```env
   OPENROUTER_API_KEY=your_key_here
   ```
3. 启动开发服务器：
   ```bash
   npm run dev
   ```
4. 在浏览器访问 [http://localhost:3000](http://localhost:3000)。

## 功能亮点

- 自适应微信风格的视觉设计，兼顾移动端和桌面端。
- 输入对方话术与拖拽 1-10 语气强度滑杆，支持 localStorage 记住上次设置。
- 一键向 OpenRouter 模型请求 3 条不同回击，包含加载状态、错误提示与复制按钮。
- 服务端 API 路由负责调用 OpenRouter 接口，并对模型输出做解析与安全裁剪。

## 注意事项

- 模型返回为第三方服务，请留意自身的调用额度及响应延迟。
- 建议勿将真实 API Key 写入仓库，使用 `.env.local` 方式管理。
- 如果需要部署到生产环境，请在部署平台上配置 `OPENROUTER_API_KEY` 环境变量。
