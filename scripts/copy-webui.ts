import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../webui/public/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ["index.html", "styles.css", "icons.svg", "icons-LICENSE.txt"]) {
  await copyFile(new URL(`../../webui/public/${name}`, import.meta.url), new URL(name, destination));
}
await copyFile(new URL("../../images/logo/mini-logo.png", import.meta.url), new URL("mini-logo.png", destination));
await copyFile(new URL("../../webui/native-folder-dialog.ps1", import.meta.url), new URL("../webui/native-folder-dialog.ps1", import.meta.url));
