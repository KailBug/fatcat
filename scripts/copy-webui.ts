import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../webui/public/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ["index.html", "styles.css", "favicon.svg"]) {
  await copyFile(new URL(`../../webui/public/${name}`, import.meta.url), new URL(name, destination));
}
