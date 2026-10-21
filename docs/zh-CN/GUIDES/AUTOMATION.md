

<a id="scheduled-and-file-change-tasks"></a>

# 定时任务与文件变化任务

[English](../../en/GUIDES/AUTOMATION.md) | 简体中文

[文档首页](../README.md) · [Automation 架构](../ARCHITECTURE/AUTOMATION.md)

<a id="schedule-work-in-a-session"></a>

## 在会话中安排任务

在 chat、TUI 或 Web UI 描述任务及触发条件，例如：“每十分钟检查这个项目的 TODO 文件并报告变化，执行三次后停止。”应确认工具确实创建了任务；自然语言承诺不代表已安排调度。

任务绑定当前已保存 Session。后续触发沿用其历史、工作区和当前权限，即使界面正在显示其他会话。Chat/TUI 的 `/cron <description>` 将调度请求发送给模型；`/cron`、`/cron list`、`/cron pause <id>`、`/cron resume <id>` 和 `/cron delete <id>` 在本地管理任务。Web UI 的 **Cron tasks** 面板支持绑定已有/新会话并填写触发条件。

保持进程运行，并选中对应工作区。任务发现覆盖当前工作区及其中其他会话；全局会话列表不意味着会调度所有已保存工作区。切换目录会停止监控原目录，返回也不会补跑错过的触发。任务定义、计数和过期时间会持久化，但不会安装 Windows 服务或系统调度器。Fork 不复制任务；加入项目或修改项目目录会暂停已有任务供复核；删除会话会删除其任务。恢复任务不重置计数和过期时间。

默认最多尝试 20 次、运行 24 小时，上限分别为 1000 次和七天。每个会话最多 32 个任务，每个工作区最多 128 个启用任务和 64 个监控文件。失败尝试也计入上限。写入和命令仍遵循当前审批规则，安排任务不等于授予无人值守权限。

<a id="file-change-triggers"></a>

## 文件变化触发

选择明确的工作区文本文件。即使在 Free to go 模式，也拒绝目录、glob、隐藏路径、链接和工作区外路径。单文件不超过 1 MiB，父目录必须存在。一个触发器接受 1–32 个文件，去抖时间为 1–60 秒。

调度器在空闲时轮询。自动回合期间的全部变化（包括外部修改）会在结束后刷新基线时忽略，以防自触发循环。两次轮询间变化后又恢复相同字节的情况可能漏检。监控路径不可读或无效会暂停会话任务，应检查状态并修复路径后再恢复。

<a id="standalone-json-runner"></a>

## 独立 JSON 运行器

此高级模式使用固定配置，每次触发创建新的已保存 Session，计数仅保留在当前进程。它与绑定会话的任务分开。

```powershell
pnpm start --automation automation.example.json --check-automation
pnpm start --automation automation.example.json --permission read-only
```

第一条命令只进行本地验证，无需模型凭据。第二条运行仓库的[示例配置](../../../automation.example.json)。配置文件和被监控文件的相对路径均基于选定工作区，而非 JSON 所在目录。最小间隔配置如下：

```json
{
  "version": 1,
  "maxRuns": 2,
  "maxRuntimeSeconds": 300,
  "tasks": [
    {
      "id": "review",
      "prompt": "Read the workspace README and summarize outstanding work.",
      "trigger": { "type": "interval", "seconds": 60 }
    }
  ]
}
```

支持间隔、一次性时间、五字段数字 cron 和文件变化触发。字段、默认值和语法见[自动任务配置](../REFERENCE/CONFIGURATION.md#automation-json)；合并触发、时间/DST 与锁行为见 [Automation 架构](../ARCHITECTURE/AUTOMATION.md#scheduling-and-file-semantics)。

配置只读取一次。重启会重置独立运行器计数、间隔和文件基线；跳过过期的一次性触发和离线期间的 cron。权限来自启动选项，不能来自 JSON。管道输入不能批准操作。无人值守时只使用明确授权的权限。

结果以 JSON 行输出到 stdout（`automation_finished`），生命周期/执行报告输出到 stderr。应逐项检查：过期或预算耗尽退出码为 0，即使某次尝试失败，包括未能创建或保存该次触发的 Session。Ctrl+C 取消当前工作并以 130 退出，不回滚已完成写入。导致运行器停止的配置、调度锁或文件监控错误返回非零。选定会话存储中的工作区锁阻止重复调度器；崩溃后先确认记录的所有者进程已退出，再仅移除其陈旧锁。
