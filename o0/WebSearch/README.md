# OpenClaude local SearXNG

Self-hosted search for OpenClaude `WebSearch` tool.

- **URL:** `http://127.0.0.1:8888/search?q=...&format=json`
- **Start:** GUI 启动时自动拉起（无黑窗口）；也可手动 `start.cmd`
  - 优先 **Docker** 官方镜像 `searxng/searxng`
  - 无 Docker 时用隐藏的 **Node 兼容服务** `server.mjs`
- **Stop:** GUI 关闭时自动停止；也可手动 `stop.cmd`

## OpenClaude env（GUI harness）

有 **Tavily** 且设置 `webSearchBackend=tavily`（设置页可切换）时：

```
WEB_SEARCH_PROVIDER=tavily
TAVILY_API_KEY=tvly-...
```

选 **本地 SearXNG**（`webSearchBackend=local`）时：

```
WEB_SEARCH_PROVIDER=custom
WEB_PROVIDER=searxng
WEB_SEARCH_API=http://127.0.0.1:8888/search
WEB_PARAMS={"format":"json"}
WEB_CUSTOM_ALLOW_HTTP=true
WEB_CUSTOM_ALLOW_PRIVATE=true
```

## Release

`编译 by o0` 会把本目录复制到 `o0\Release\WebSearch`。
