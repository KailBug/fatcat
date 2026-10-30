import { parentPort, workerData } from "node:worker_threads";

const { lines, query, ignoreCase } = workerData as { lines: string[]; query: string; ignoreCase: boolean };
const expression = new RegExp(query, ignoreCase ? "iu" : "u");
parentPort!.postMessage(lines.flatMap((line, index) => expression.test(line) ? [index] : []));
