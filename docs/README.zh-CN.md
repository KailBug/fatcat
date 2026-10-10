<p align="center">
  <img src="../images/logo/logo_20260922_140805.png" alt="Fatcat，一只坐着的虎斑猫" width="240">
</p>

<h1 align="center">Fatcat</h1>

<p align="center">
  <a href="https://github.com/KailBug/fatcat/stargazers"><img src="https://img.shields.io/github/stars/KailBug/fatcat?style=flat&amp;logo=github&amp;label=stars" alt="GitHub Stars"></a>
  <a href="https://github.com/KailBug/fatcat/blob/main/package.json"><img src="https://img.shields.io/github/package-json/v/KailBug/fatcat/main?label=version&amp;color=blue" alt="main 分支的项目版本"></a>
  <a href="https://github.com/KailBug/fatcat/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/KailBug/fatcat/ci.yml?branch=main&amp;event=push&amp;label=CI&amp;logo=githubactions&amp;logoColor=white" alt="main 分支 Windows CI 状态"></a>
  <a href="USAGE.md"><img src="https://img.shields.io/badge/docs-usage-blue" alt="安装与使用文档"></a>
  <br>
  <a href="../package.json"><img src="https://img.shields.io/badge/Node.js-24.x-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24.x"></a>
  <a href="../package.json"><img src="https://img.shields.io/badge/pnpm-11.21.0-F69220?logo=pnpm&amp;logoColor=white" alt="pnpm 11.21.0"></a>
  <a href="../tsconfig.json"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&amp;logoColor=white" alt="TypeScript 严格模式"></a>
  <a href="USAGE.md#windows-setup"><img src="https://img.shields.io/badge/platform-Windows-0078D4" alt="原生 Windows 支持"></a>
</p>

<p align="center"><a href="../README.md">English</a> | 简体中文</p>

一个用于本地编程实验的小型 TypeScript Agent Harness demo，支持 DeepSeek、Kimi、MiMo 和 Qwen，原生运行于 Windows。

项目仍处于早期 demo 阶段，目前支持简单的 Agent Loop、CLI 对话、可选 TUI 与本地 Web UI、按工作目录保存的会话及恢复/分支、保留原始历史的手动上下文压缩、内置与本地 Skills 的按需读取、工作目录读取、文本搜索与受控编辑、经授权的 Windows 命令执行，根据任务选择的有界子 Agent 委派，有界模型请求与超限时的旧读取内容省略，以及执行、上下文、token 用量和供应商缓存遥测。新增三家供应商按官方协议进行离线验证，未据此宣称 API 在线验证通过。

[安装与使用（英文）](USAGE.md)
