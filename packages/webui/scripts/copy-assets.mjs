import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

const client = new URL("../dist/client/", import.meta.url);
// Use the declared, pinned package's standalone ESM; no CDN, bundler or Node browser imports.
const marked = new URL(import.meta.resolve("marked/package.json"));
await copyFile(new URL("lib/marked.esm.js", marked), new URL("marked.js", client));
const markdown = new URL("markdown.js", client);
await writeFile(markdown, (await readFile(markdown, "utf8")).replace(/from (["'])marked\1/g, 'from "./marked.js"'));
const modules = (await readdir(client)).filter((name) => name.endsWith(".js"));
for (const name of modules) {
	const source = await readFile(new URL(name, client), "utf8");
	const imports = [
		/^\s*(?:import|export)\s+(?:[^;"']*?\sfrom\s+)?(["'])([^"'\r\n]+)\1/gm,
		/\bimport\s*\(\s*(["'])([^"'\r\n]+)\1/g,
	].flatMap((expression) => [...source.matchAll(expression)].map((match) => match[2]));
	for (const specifier of imports) {
		if (!specifier.startsWith("./") || !modules.includes(specifier.slice(2))) {
			throw new Error(`Browser module ${name} imports a non-client module: ${specifier}`);
		}
	}
}

const destination = new URL("../dist/public/", import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(new URL("LICENSE", marked), new URL("marked-LICENSE.md", destination));
for (const name of ["index.html", "styles.css", "icons.svg", "icons-LICENSE.txt", "walking.png", "looking.png", "sleeping.png"]) {
	await copyFile(new URL(`../src/public/${name}`, import.meta.url), new URL(name, destination));
}
// Keep one repository-wide logo source; runtime serves only the package-local copy.
await copyFile(new URL("../../../images/logo/mini-logo.png", import.meta.url), new URL("mini-logo.png", destination));
await copyFile(new URL("../src/native-folder-dialog.ps1", import.meta.url), new URL("../dist/native-folder-dialog.ps1", import.meta.url));
