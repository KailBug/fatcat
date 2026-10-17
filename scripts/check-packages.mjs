import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packages = ["runtime", "commands", "tui", "webui", "cli", "verification"].map((name) => ({
	source: resolve(root, `packages/${name}${name === "verification" ? "" : "/src"}`),
	directories: (name === "verification" ? ["tests", "verify", "scripts"] : ["src"])
		.map((directory) => resolve(root, `packages/${name}/${directory}`)),
	manifest: JSON.parse(readFileSync(resolve(root, `packages/${name}/package.json`), "utf8")),
}));
const allowed = {
	"@fatcat/verification": ["@fatcat/runtime", "@fatcat/commands", "@fatcat/tui", "@fatcat/webui", "@fatcat/cli"],
	"@fatcat/cli": ["@fatcat/runtime", "@fatcat/commands", "@fatcat/tui", "@fatcat/webui"],
	"@fatcat/runtime": [],
	"@fatcat/commands": ["@fatcat/runtime"],
	"@fatcat/tui": ["@fatcat/runtime", "@fatcat/commands"],
	"@fatcat/webui": ["@fatcat/runtime", "@fatcat/commands"],
};
const host = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const failures = [];

function inside(directory, path) {
	const local = relative(directory, path);
	return !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
}

function files(directory, extension) {
	return readdirSync(directory, { recursive: true })
		.filter((file) => file.endsWith(extension)).map((file) => resolve(directory, file));
}

function imports(source) {
	const expressions = [
		/^\s*(?:import|export)\s+(?:[^;"']*?\sfrom\s+)?(["'])([^"'\r\n]+)\1/gm,
		/\b(?:import|require)\s*\(\s*(["'])([^"'\r\n]+)\1/g,
		/createRequire\(import\.meta\.url\)\s*(?:\.resolve)?\s*\(\s*(["'])([^"'\r\n]+)\1/g,
		/import\.meta\.resolve\(\s*(["'])([^"'\r\n]+)\1/g,
	];
	return expressions.flatMap((expression) => [...source.matchAll(expression)].map((match) => match[2]));
}

for (const directory of [...packages.flatMap((entry) => entry.directories), resolve(root, "scripts")]) {
	for (const file of files(directory, ".ts")) {
		const owner = packages.find((entry) => inside(entry.source, file));
		const verification = owner?.manifest.name === "@fatcat/verification";
		for (const specifier of imports(readFileSync(file, "utf8"))) {
			const fail = (reason) => failures.push(`${relative(root, file)}: ${reason} (${specifier})`);
			if (specifier.startsWith("node:")) continue;
			if (specifier.startsWith(".")) {
				const target = resolve(dirname(file), specifier);
				if (owner && !inside(owner.source, target)) fail("Package-relative imports must stay inside their source owner");
				if (!owner && inside(resolve(root, "packages"), target)) fail("Use package exports instead of a relative cross-package import");
				continue;
			}
			const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
			const dependencies = owner
				? { ...owner.manifest.dependencies, ...(verification ? owner.manifest.devDependencies : {}) }
				: { ...host.dependencies, ...host.devDependencies };
			if (!Object.hasOwn(dependencies, name)) fail("Import requires a direct dependency declaration");
			const target = packages.find((entry) => entry.manifest.name === name);
			if (target) {
				if (owner && !allowed[owner.manifest.name].includes(name)) fail("Workspace dependency direction is not allowed");
				const subpath = `.${specifier.slice(name.length)}`;
				if (subpath.startsWith("./internal/")) {
					if (!verification) fail("Internal package subpaths are for verification only");
					if (!Object.hasOwn(target.manifest.exports, "./internal/*")) fail("Package does not expose verification internals");
				} else if (!Object.hasOwn(target.manifest.exports, subpath)) fail("Package subpath is not exported");
			}
		}
	}
}

for (const { manifest } of packages) {
	if (manifest.name === "@fatcat/cli" && manifest.version !== host.version) {
		failures.push("CLI and root application versions must match");
	}
	for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
		if (dependency.startsWith("@fatcat/") && !allowed[manifest.name].includes(dependency)) {
			failures.push(`Workspace dependency direction is not allowed: ${manifest.name} -> ${dependency}`);
		}
	}
	for (const [subpath, entry] of Object.entries(manifest.exports)) {
		if (!entry.types?.startsWith("./dist/") || !entry.import?.startsWith("./dist/")) {
			failures.push(`Package export must resolve built JavaScript and declarations: ${manifest.name}${subpath}`);
		}
	}
}
if (failures.length) throw new Error(failures.join("\n"));
console.log("Workspace package boundaries verified.");
