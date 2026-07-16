# Agent Trace

本地 CLI agent trace 采集、结构化存储和人工审计平台。第一版支持 OpenCode，
并保留 adapter 接口供后续接入其他 CLI agent。

## 安装

```powershell
npm install
npm run build
npm link
```

## 使用

```powershell
# 启动交互式 OpenCode，并实时采集当前会话
agent-trace run opencode D:\path\to\project

# 运行单次任务
agent-trace run opencode run "检查当前项目并给出建议"

# 打开审计界面
agent-trace ui

# 查询、导入和导出
agent-trace sessions --search "keyword"
agent-trace show <session_id>
agent-trace events <session_id>
agent-trace import opencode --session <session_id>
agent-trace export <session_id> --output trace.json
agent-trace query "SELECT event_type, COUNT(*) FROM events GROUP BY event_type"
```

Collector 默认监听 `127.0.0.1:4318`。通过 `AGENT_TRACE_HOME` 修改本地数据目录，
通过 `AGENT_TRACE_PORT` 修改端口。所有原始提示词、推理、工具参数/输出和 diff
均以明文保存在本机。

## 开发验证

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e
```
