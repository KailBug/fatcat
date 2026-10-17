type Token = { value: string; literal: boolean; dynamic: boolean };
type Scan = { commands: Token[][]; uncertain: boolean };

const opaque = "This command uses dynamic code, a nested interpreter, or syntax that requires review.";
const deletion = "This command deletes files, directories, or registry data.";
const storage = "This command can erase or repartition storage.";
const history = "This Git command can discard work or rewrite history.";
const security = "This command changes security controls, system services, or running processes.";

const quoteKind = (value: string | undefined): "single" | "double" | undefined =>
  value === "'" || value === "\u2018" || value === "\u2019" ? "single"
    : value === '"' || value === "\u201c" || value === "\u201d" ? "double" : undefined;

/** A bounded lexical check, not a PowerShell parser or a security sandbox. */
function scan(command: string): Scan {
  const commands: Token[][] = [];
  let current: Token[] = [];
  let uncertain = false;
  let index = 0;
  const flush = () => { if (current.length) commands.push(current); current = []; };
  while (index < command.length) {
    const character = command[index]!;
    if (character === "\r" || character === "\n" || character === ";" || character === "|") {
      flush(); index++; continue;
    }
    if (/\s/.test(character)) { index++; continue; }
    if (character === "#") {
      while (index < command.length && command[index] !== "\n") index++;
      continue;
    }
    if (command.slice(index, index + 2) === "<#") {
      const end = command.indexOf("#>", index + 2);
      if (end === -1) { uncertain = true; break; }
      index = end + 2; continue;
    }
    if (character === "&") {
      if (current.length || command[index + 1] === "&") uncertain = true;
      current.push({ value: "&", literal: false, dynamic: false }); index++; continue;
    }
    if (/[(){}\[\]]/.test(character)) { uncertain = true; index++; continue; }
    let value = "";
    let literal = true;
    let dynamic = false;
    while (index < command.length) {
      const next = command[index]!;
      if (/\s/.test(next) || ";|".includes(next)) break;
      if (next === "&") {
        // A stream redirect such as 2>&1 does not invoke another command.
        if (value.endsWith(">") && /[0-9]/.test(command[index + 1] ?? "")) {
          value += next; index++; continue;
        }
        break;
      }
      if (/[(){}\[\]]/.test(next)) { uncertain = true; index++; continue; }
      const here = next === "@" && quoteKind(command[index + 1]) && /[\r\n]/.test(command[index + 2] ?? "");
      const kind = quoteKind(here ? command[index + 1] : next);
      if (kind) {
        index += here ? 2 : 1;
        let ended = false;
        while (index < command.length) {
          const quoted = command[index]!;
          const endHere = here && (index === 0 || command[index - 1] === "\n")
            && quoteKind(quoted) === kind && command[index + 1] === "@";
          if (endHere) { index += 2; ended = true; break; }
          if (!here && quoteKind(quoted) === kind) {
            if (quoteKind(command[index + 1]) === kind) { value += quoted; index += 2; continue; }
            index++; ended = true; break;
          }
          if (kind === "double" && quoted === "`") {
            if (index + 1 >= command.length) { uncertain = true; index++; break; }
            value += command[index + 1]; index += 2; continue;
          }
          if (kind === "double" && quoted === "$") {
            dynamic = true;
            if (command[index + 1] === "(") uncertain = true;
          }
          value += quoted; index++;
        }
        if (!ended) uncertain = true;
        continue;
      }
      literal = false;
      if (next === "`") {
        index++;
        if (command[index] === "\r") index++;
        if (command[index] === "\n") { index++; continue; }
        if (index >= command.length) { uncertain = true; break; }
        value += command[index]; index++; continue;
      }
      if (next === "$") dynamic = true;
      value += next; index++;
    }
    current.push({ value, literal, dynamic });
  }
  flush();
  return { commands, uncertain };
}

function name(value: string): string {
  return value.toLowerCase().split(/[\\/]/).at(-1)!.replace(/\.(exe|cmd|bat|com)$/i, "");
}

const deleting = new Set(["remove-item", "remove-itemproperty", "clear-item", "clear-itemproperty", "clear-content",
  "rm", "ri", "del", "erase", "rd", "rmdir", "shred", "sdelete", "unlink"]);
const erasing = new Set(["format", "format-volume", "clear-disk", "initialize-disk", "remove-partition", "new-partition",
  "set-partition", "resize-partition", "diskpart", "dd", "mkfs", "wipefs"]);
const changingSecurity = new Set(["set-mppreference", "add-mppreference", "remove-mppreference", "set-executionpolicy",
  "unblock-file", "set-netfirewallprofile", "new-netfirewallrule", "set-netfirewallrule", "disable-netfirewallrule",
  "remove-netfirewallrule", "stop-service", "set-service", "remove-service", "disable-scheduledtask",
  "unregister-scheduledtask", "stop-process", "kill", "taskkill", "netsh", "net", "sc", "bcdedit", "vssadmin",
  "icacls", "takeown", "shutdown", "restart-computer", "stop-computer", "cipher", "set-acl", "new-service",
  "set-scheduledtask", "new-localuser", "set-localuser", "add-localgroupmember", "set-localgroup"]);
const nested = new Set(["invoke-expression", "iex", "invoke-command", "icm", "start-process", "saps", "start-job",
  "start-threadjob", "powershell", "pwsh", "cmd", "bash", "sh", "wsl", "cscript", "wscript", "mshta",
  "rundll32", "regsvr32", "set-alias", "new-alias", "sal", "nal", "import-module", "ipmo"]);
const ordinary = new Set(["pnpm", "npm", "yarn", "git", "rg", "ripgrep", "fd", "findstr", "where", "where-object",
  "ls", "dir", "gci", "cat", "gc", "type", "pwd", "gl", "cd", "sl", "pushd", "popd", "echo", "write",
  "select", "sort", "measure", "tee", "out-string", "out-null", "out-file", "exit", "return", "curl", "wget",
  "iwr", "irm", "tsc", "eslint", "prettier", "vitest", "jest", "pytest", "dotnet", "cargo", "go", "make",
  "cmake", "msbuild", "gradle", "gradlew", "mvn", "mvnw", "gcc", "g++", "clang", "cl", "javac",
  "invoke-webrequest", "invoke-restmethod", "import-csv"]);
const gitCommands = new Set(["status", "diff", "log", "show", "ls-files", "ls-tree", "rev-parse", "branch", "switch",
  "checkout", "add", "commit", "merge", "fetch", "pull", "push", "clone", "tag", "remote", "describe", "config",
  "init", "restore", "reset", "clean", "rebase", "cherry-pick", "stash", "apply", "mv", "version", "help"]);

function gitRisk(args: string[]): string | null {
  const values = [...args];
  while (values[0]?.startsWith("-")) {
    const option = values.shift()!;
    if (["--version", "--help", "-h"].includes(option)) return null;
    if (option === "-c" || option.startsWith("--config-env") || option.startsWith("--exec-path")) return opaque;
    if (["-C", "--git-dir", "--work-tree", "--namespace"].includes(option)) values.shift();
    else if (!option.includes("=") && option !== "--no-pager" && option !== "--paginate" && option !== "-p") return opaque;
  }
  const operation = values.shift();
  if (!operation || !gitCommands.has(operation)) return opaque;
  if (operation === "reset" && values.some((value) => value.startsWith("--h"))) return history;
  const separator = values.indexOf("--");
  const options = separator === -1 ? values : values.slice(0, separator);
  if (operation === "clean" && !options.some((value) => value === "--dry-run" || /^-[a-z]*n[a-z]*$/.test(value))) return deletion;
  if (operation === "push" && values.some((value) => value.startsWith("--force") || value === "-f"
    || value === "--mirror" || value === "--delete" || value === "-d" || value.startsWith("+"))) return history;
  if (["checkout", "switch"].includes(operation) && values.some((value) => value === "-f" || value.startsWith("--force"))) return history;
  if (operation === "checkout" && values.some((value) => value === "--" || value === ".")) return history;
  if (operation === "restore" && !values.includes("--help")) return history;
  if (["branch", "tag"].includes(operation) && values.some((value) => value === "-d" || value === "-D" || value === "--delete")) return history;
  if (operation === "stash" && ["drop", "clear"].includes(values[0] ?? "")) return history;
  if (operation === "config" && values.some((value) => /^(alias\.|core\.(hooksPath|pager)|credential\.)/i.test(value))) return opaque;
  return null;
}

function commandRisk(tokens: Token[]): string | null {
  const invoked = tokens[0]?.value === "&";
  if (invoked) tokens = tokens.slice(1);
  const head = tokens[0];
  if (!head || head.dynamic || head.value === "." || head.value === "--%") return opaque;
  // A standalone quoted literal produces text; only & invokes its value as a command.
  if (head.literal && !invoked) return tokens.length === 1 ? null : opaque;
  const command = name(head.value);
  const args = tokens.slice(1).map((token) => token.value.toLowerCase());
  if (args.includes("--%")) return opaque;
  if (deleting.has(command)) return deletion;
  if (erasing.has(command)) return storage;
  if (changingSecurity.has(command)) return security;
  if (nested.has(command) || /\.(ps1|psm1|psd1|vbs|js|mjs|cjs|py|rb|pl|php)$/i.test(head.value)) return opaque;
  if (["git", "pnpm", "npm", "yarn", "node", "python", "python3", "py", "reg", "robocopy"].includes(command)
    && tokens.slice(1).some((token) => token.dynamic)) return opaque;
  if (command === "reg") return ["query", "compare", "export", "save"].includes(args[0] ?? "") ? null : deletion;
  if (command === "robocopy") return args.some((arg) => ["/mir", "/purge", "/mov", "/move"].includes(arg)) ? deletion : null;
  if (command === "git") return gitRisk(tokens.slice(1).map((token) => token.value));
  if (["node", "python", "python3", "py"].includes(command)) {
    if (args.length === 1 && ["--version", "-v", "--help", "-h"].includes(args[0]!)) return null;
    if (command === "node" && args[0] === "--test" && !args.some((arg) => /^(-e|-p|-r)|^(--eval|--print|--require|--import)(=|$)/.test(arg))) return null;
    if (command !== "node" && args[0] === "-m" && ["pytest", "unittest"].includes(args[1] ?? "")) return null;
    return opaque;
  }
  if (["pnpm", "npm", "yarn"].includes(command)) {
    if (args.some((arg) => arg === "-c" || arg === "--shell-mode" || arg.startsWith("--call"))) return opaque;
    const exec = args.indexOf("exec");
    if (exec !== -1) {
      const nestedTokens = tokens.slice(exec + 2);
      while (nestedTokens[0]?.value === "--") nestedTokens.shift();
      return commandRisk(nestedTokens);
    }
    if (args.includes("dlx")) return opaque;
    return null;
  }
  if (["set-itemproperty", "new-itemproperty"].includes(command)) return security;
  if (["set-item", "new-item"].includes(command) && tokens.slice(1).some((token) => token.dynamic
    || /^(-[a-z]+:)?(hklm|hkcu|hkcr|hku|hkcc):|^(-[a-z]+:)?registry::/.test(token.value.toLowerCase()))) return security;
  if (/^(set|new|add)-/.test(command) && args.some((arg) => /^(-[a-z]+:)?(env|alias|function):/.test(arg))) return opaque;
  if (ordinary.has(command) || /^(get|select|format|write|measure|compare|test|resolve|split|join|convertfrom|convertto|set|add|new|copy|move|rename|export)-[a-z][a-z0-9-]*$/.test(command)) return null;
  return "This command invokes a tool or script whose effects are not recognized by the built-in checks.";
}

/** Return an English approval reason, or null for an ordinary recognized command. */
export function classifyCommandRisk(command: string): string | null {
  if (!command.trim() || command.length > 4000) return opaque;
  const parsed = scan(command);
  if (parsed.uncertain) return opaque;
  for (const tokens of parsed.commands) {
    const reason = commandRisk(tokens);
    if (reason) return reason;
  }
  return null;
}
