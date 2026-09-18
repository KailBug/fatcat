export type Config = {
  apiKey: string;
  model: string;
  maxIterations: number;
};

/** Read only the settings used by the first phase; never log this object. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("缺少 DEEPSEEK_API_KEY，请在 .env 或环境变量中配置。");
  }

  const model = (env.DEEPSEEK_MODEL ?? "deepseek-flash").trim();
  if (!model) {
    throw new Error("DEEPSEEK_MODEL 不能为空。");
  }

  const rawMaxIterations = (env.HARNESS_MAX_ITERATIONS ?? "8").trim();
  const maxIterations = Number(rawMaxIterations);
  if (!/^[1-9]\d*$/.test(rawMaxIterations) || !Number.isSafeInteger(maxIterations)) {
    throw new Error("HARNESS_MAX_ITERATIONS 必须是十进制正整数，且不能超过 JavaScript 安全整数上限。");
  }

  return { apiKey, model, maxIterations };
}
