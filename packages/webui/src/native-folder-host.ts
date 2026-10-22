import { spawn } from "node:child_process";

// This detached host outlives the server only until its helper finishes restoring
// the browser. Windows PowerShell itself cannot start without a console host.
const child = spawn(process.argv[2]!, process.argv.slice(3), {
	windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
});
child.stdin.on("error", () => {});
process.stdin.on("error", () => child.stdin.end());
process.stdout.on("error", () => child.stdout.resume());
process.stderr.on("error", () => child.stderr.resume());
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once("error", () => { process.exitCode = 1; });
child.once("close", (code) => {
	process.exitCode = code ?? 1;
	process.stdin.destroy();
});
