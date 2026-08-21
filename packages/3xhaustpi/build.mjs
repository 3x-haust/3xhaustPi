import { chmod, copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname);
const outputDirectory = resolve(packageRoot, "dist");

await mkdir(outputDirectory, { recursive: true });
await build({
	entryPoints: {
		cli: resolve(packageRoot, "src/cli-launcher.ts"),
		"cli-full": resolve(packageRoot, "src/cli.ts"),
		"cli-tui": resolve(packageRoot, "src/cli-tui.ts"),
		"credential-broker": resolve(packageRoot, "src/credential-broker.ts"),
		"auth-runtime": resolve(packageRoot, "src/auth-runtime.ts"),
		"desktop-runtime": resolve(packageRoot, "src/desktop-runtime.ts"),
		runtime: resolve(packageRoot, "src/coding-runtime.ts"),
		"tui-runtime-worker": resolve(packageRoot, "src/tui-runtime-worker.ts"),
	},
	outdir: outputDirectory,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	banner: { js: "#!/usr/bin/env node" },
	sourcemap: true,
	minify: false,
	external: [
		"node:sqlite",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-ai/*",
		"@napi-rs/keyring",
	],
});
await copyFile(resolve(packageRoot, "src/runtime-api.d.ts"), resolve(outputDirectory, "runtime.d.ts"));
await copyFile(resolve(packageRoot, "src/auth-runtime-api.d.ts"), resolve(outputDirectory, "auth-runtime.d.ts"));
await copyFile(
	resolve(packageRoot, "src/desktop-runtime-api.d.ts"),
	resolve(outputDirectory, "desktop-runtime.d.ts"),
);
await mkdir(resolve(outputDirectory, "macos"), { recursive: true });
await copyFile(resolve(packageRoot, "src/macos/ax_host.jxa"), resolve(outputDirectory, "macos/ax_host.jxa"));
await mkdir(resolve(outputDirectory, "windows"), { recursive: true });
await copyFile(resolve(packageRoot, "src/windows/uia_host.ps1"), resolve(outputDirectory, "windows/uia_host.ps1"));
await mkdir(resolve(outputDirectory, "linux"), { recursive: true });
await copyFile(resolve(packageRoot, "src/linux/atspi_host.py"), resolve(outputDirectory, "linux/atspi_host.py"));
await mkdir(resolve(outputDirectory, "python"), { recursive: true });
await copyFile(
	resolve(packageRoot, "src/python/read_worker.py"),
	resolve(outputDirectory, "python/read_worker.py"),
);
await chmod(resolve(outputDirectory, "cli.js"), 0o755);
await chmod(resolve(outputDirectory, "credential-broker.js"), 0o700);
await chmod(resolve(outputDirectory, "macos/ax_host.jxa"), 0o700);
await chmod(resolve(outputDirectory, "linux/atspi_host.py"), 0o700);
