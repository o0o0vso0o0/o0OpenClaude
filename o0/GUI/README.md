# AI Cursor — OpenClaude GUI

本地网页 GUI（TypeScript + React），**不启动 TUI**。

## 功能

- 左侧会话列表（右键删除）
- 中间流式聊天
- 对话框处选择模型（系列 Tab、按发布日排序、显示输入/输出价）
- 设置：OpenAI 兼容 API（默认 ChatAnywhere `https://api.chatanywhere.tech/v1`）

## 一键测试（by o0）

双击 `..\测试 by o0.cmd`（无黑窗口）：在 `o0\GUI` 里 `npm run build` 后后台启动服务，自动打开 `http://127.0.0.1:3920`。关浏览器标签即停服务。设置/会话存在 `o0\.cache\o0Data`。

热更新开发仍可用下面「开发」双终端方式。

## 开发

```powershell
cd C:\o0Project\o0OpenClaude\o0\GUI
npm install
# 终端 1：API
npm run dev
# 终端 2：Vite UI
npm run dev:ui
```

浏览器打开 Vite 提示的地址（默认 `http://127.0.0.1:5173`，API 经代理到 3920）。

## 生产（打包进 Release）

运行 `..\编译 by o0.cmd` 编译进 Release，然后双击：

```text
o0\Release\OpenClaude-GUI.cmd
```

会启动本地服务并打开浏览器，无需 TUI。设置/会话存在 `Release\o0Data`（编译不会删除该目录）。
