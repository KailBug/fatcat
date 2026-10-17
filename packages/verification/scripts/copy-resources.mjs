import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../dist/verify/native/support/", import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(new URL("../verify/native/support/inspect-folder-picker.ps1", import.meta.url),
	new URL("inspect-folder-picker.ps1", destination));
