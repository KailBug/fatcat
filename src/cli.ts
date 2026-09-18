import { loadConfig } from "./config.js";

const help = `Agent Harness — 工程准备阶段

用法：
  pnpm start --help          显示帮助（不需要 API Key）
  pnpm start --check-config  检查本地配置（不发送模型请求）

当前尚未接入模型请求、工具执行和 Agent Loop，暂不接受任务输入。
配置检查只确认字段有效，不代表密钥、模型权限或网络连接可用。`;

function main(args: string[]): number {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]!))) {
    console.log(help);
    return 0;
  }

  if (args.length !== 1 || args[0] !== "--check-config") {
    console.error("暂不支持该参数或任务输入。请运行 pnpm start --help 查看当前能力。");
    return 2;
  }

  try {
    const config = loadConfig();
    console.log("本地配置检查通过（未连接 DeepSeek）。");
    console.log(`模型：${config.model}`);
    console.log(`最大迭代次数：${config.maxIterations}（Loop 尚未实现）`);
    console.log("API Key：已配置（不显示内容）");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "配置检查失败。");
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
