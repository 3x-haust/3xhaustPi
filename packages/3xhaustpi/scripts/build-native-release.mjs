#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const nodeVersion = "22.23.1";
const pythonVersion = "3.13.14";
const pythonRelease = "20260728";
const keyringVersion = "1.3.0";

const targets = {
	"darwin-arm64": {
		nodeName: `node-v${nodeVersion}-darwin-arm64.tar.gz`,
		nodeSha256: "ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953",
		pythonName: `cpython-${pythonVersion}+${pythonRelease}-aarch64-apple-darwin-install_only_stripped.tar.gz`,
		pythonSha256: "aa2a054f5e04bde63ae199e3bb6bbb634e457423efd294842deeb1299e7e5932",
		archive: "tar.gz",
		keyringPackage: "@napi-rs/keyring-darwin-arm64",
	},
	"darwin-x64": {
		nodeName: `node-v${nodeVersion}-darwin-x64.tar.gz`,
		nodeSha256: "b8da981b8a0b1241b70249204916da76c63573ddf5814dbd2d1e41069105cb81",
		pythonName: `cpython-${pythonVersion}+${pythonRelease}-x86_64-apple-darwin-install_only_stripped.tar.gz`,
		pythonSha256: "aa73c37aebebe3b7264dce1e49923719ab0ac0fc590353adf393eee3e2041c18",
		archive: "tar.gz",
		keyringPackage: "@napi-rs/keyring-darwin-x64",
	},
	"linux-arm64": {
		nodeName: `node-v${nodeVersion}-linux-arm64.tar.gz`,
		nodeSha256: "543fa39e57d4c07855939459a323f4deb9a79dd1bb45e6e99458b0f2de10db8d",
		pythonName: `cpython-${pythonVersion}+${pythonRelease}-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz`,
		pythonSha256: "1eaf979af6c6986553b91a9e3b03647f63ce52a888e00892d3bddc96f43748e9",
		archive: "tar.gz",
		keyringPackage: "@napi-rs/keyring-linux-arm64-gnu",
	},
	"linux-x64": {
		nodeName: `node-v${nodeVersion}-linux-x64.tar.gz`,
		nodeSha256: "7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129",
		pythonName: `cpython-${pythonVersion}+${pythonRelease}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
		pythonSha256: "6734c3e643c75e860c36ee3a7904e8e6bafbf3232d89b17ffd5fbfa72ab2816c",
		archive: "tar.gz",
		keyringPackage: "@napi-rs/keyring-linux-x64-gnu",
	},
	"windows-arm64": {
		nodeName: `node-v${nodeVersion}-win-arm64.zip`,
		nodeSha256: "b470fdfe3502c05151656e06d495e3f47544f2ee8b1d9c8705090f2dd5996bd0",
		pythonName: `cpython-${pythonVersion}+${pythonRelease}-aarch64-pc-windows-msvc-install_only_stripped.tar.gz`,
		pythonSha256: "e28e7108a4b36c0c321da8c842a7addf59358e26b5ec9abe002e9e940130f41f",
		archive: "zip",
		keyringPackage: "@napi-rs/keyring-win32-arm64-msvc",
	},
	"windows-x64": {
		nodeName: `node-v${nodeVersion}-win-x64.zip`,
		nodeSha256: "7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29",
		pythonName: `cpython-${pythonVersion}+${pythonRelease}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`,
		pythonSha256: "a091ab914f2b7d2dbc52e9cf4a225190f72709fc79a64ec44bc61ca4d2908a64",
		archive: "zip",
		keyringPackage: "@napi-rs/keyring-win32-x64-msvc",
	},
};

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function parseArgs() {
	const targetIndex = process.argv.indexOf("--target");
	const outputIndex = process.argv.indexOf("--output");
	const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined;
	const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
	if (!target || !(target in targets)) fail(`--target must be one of: ${Object.keys(targets).join(", ")}`);
	return { target, output: resolve(output ?? join(repositoryRoot, "artifacts", "native")) };
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repositoryRoot,
		encoding: "utf8",
		stdio: options.capture ? "pipe" : "inherit",
		timeout: options.timeout ?? 300_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.status !== 0) {
		const detail = options.capture ? (result.stderr || result.stdout || "").trim() : "";
		throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
	}
	return options.capture ? result.stdout.trim() : "";
}

async function download(url, destination, expectedSha256) {
	let lastError;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			const response = await fetch(url, {
				headers: { "user-agent": "3xhaustpi-native-release" },
				redirect: "follow",
				signal: AbortSignal.timeout(300_000),
			});
			if (!response.ok) {
				const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
				const error = new Error(`Download failed with HTTP ${response.status}: ${url}`);
				if (!retryable) throw Object.assign(error, { retryable: false });
				throw error;
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			const actual = createHash("sha256").update(bytes).digest("hex");
			if (actual !== expectedSha256) {
				throw Object.assign(
					new Error(
						`Checksum mismatch for ${basename(destination)}: expected ${expectedSha256}, received ${actual}`,
					),
					{ retryable: false },
				);
			}
			writeFileSync(destination, bytes, { mode: 0o600 });
			return;
		} catch (error) {
			lastError = error;
			if (error?.retryable === false || attempt === 3) throw error;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000));
		}
	}
	throw lastError;
}

function extractTar(archive, destination) {
	mkdirSync(destination, { recursive: true });
	run("tar", ["-xzf", archive, "-C", destination, "--strip-components=1"]);
}

function extractZip(archive, destination) {
	const expanded = join(dirname(destination), "node-expanded");
	mkdirSync(expanded, { recursive: true });
	run("unzip", ["-q", archive, "-d", expanded]);
	const entries = run("find", [expanded, "-mindepth", "1", "-maxdepth", "1", "-type", "d"], {
		capture: true,
	})
		.split("\n")
		.filter(Boolean);
	if (entries.length !== 1) throw new Error("Node archive did not contain one top-level directory");
	cpSync(entries[0], destination, { recursive: true });
}

function installApplication(staging, temporary, keyringPackage) {
	if (!existsSync(join(packageRoot, "dist", "cli.js"))) {
		throw new Error("Build packages/3xhaustpi before creating a native release");
	}
	const packOutput = run(
		"npm",
		["pack", packageRoot, "--pack-destination", temporary, "--json", "--ignore-scripts"],
		{ capture: true, timeout: 300_000 },
	);
	const packed = JSON.parse(packOutput);
	const filename = packed[0]?.filename;
	if (!filename) throw new Error("npm pack did not report an archive");
	const appRoot = join(staging, "app");
	mkdirSync(appRoot, { recursive: true });
	writeFileSync(join(appRoot, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
	run(
		"npm",
		[
			"install",
			"--omit=dev",
			"--omit=optional",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--prefix",
			appRoot,
			join(temporary, filename),
		],
		{ timeout: 300_000 },
	);
	run(
		"npm",
		[
			"install",
			"--omit=dev",
			"--omit=optional",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--no-save",
			"--force",
			"--prefix",
			appRoot,
			`${keyringPackage}@${keyringVersion}`,
		],
		{ timeout: 300_000 },
	);
	const entry = join(appRoot, "node_modules", "3xhaustpi", "dist", "cli.js");
	if (!existsSync(entry)) throw new Error("Installed native application is missing dist/cli.js");
	if (!existsSync(join(appRoot, "node_modules", keyringPackage, "package.json"))) {
		throw new Error(`Installed native application is missing ${keyringPackage}`);
	}
}

function writeLaunchers(staging, target) {
	const bin = join(staging, "bin");
	mkdirSync(bin, { recursive: true });
	if (target.startsWith("windows-")) {
		writeFileSync(
			join(bin, "3xhaustpi.cmd"),
			[
				"@echo off",
				"setlocal",
				'set \"X3HAUSTPI_ROOT=%~dp0..\"',
				'set \"X3HAUSTPI_PYTHON=%X3HAUSTPI_ROOT%\\runtime\\python\\python.exe\"',
				'\"%X3HAUSTPI_ROOT%\\runtime\\node\\node.exe\" \"%X3HAUSTPI_ROOT%\\app\\node_modules\\3xhaustpi\\dist\\cli.js\" %*',
				"exit /b %ERRORLEVEL%",
				"",
			].join("\r\n"),
		);
		return;
	}
	const launcher = join(bin, "3xhaustpi");
	writeFileSync(
		launcher,
		[
			"#!/bin/sh",
			'set -eu',
			'three_xhaustpi_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)',
			'export X3HAUSTPI_PYTHON="$three_xhaustpi_root/runtime/python/bin/python3"',
			'exec "$three_xhaustpi_root/runtime/node/bin/node" "$three_xhaustpi_root/app/node_modules/3xhaustpi/dist/cli.js" "$@"',
			"",
		].join("\n"),
	);
	chmodSync(launcher, 0o755);
}

function writeManifest(staging, target) {
	writeFileSync(
		join(staging, "runtime-manifest.json"),
		`${JSON.stringify(
			{
				formatVersion: 1,
				product: "3xhaustpi",
				version: JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version,
				target,
				node: nodeVersion,
				python: pythonVersion,
				pythonRelease,
			},
			null,
			2,
		)}\n`,
	);
}

function createArchive(stagingParent, target, output, format) {
	mkdirSync(output, { recursive: true });
	const filename = `3xhaustpi-${target}.${format}`;
	const destination = join(output, filename);
	rmSync(destination, { force: true });
	if (format === "zip") {
		run("zip", ["-q", "-r", destination, "3xhaustpi"], { cwd: stagingParent });
	} else {
		run("tar", ["-czf", destination, "3xhaustpi"], { cwd: stagingParent });
	}
	const checksum = createHash("sha256").update(readFileSync(destination)).digest("hex");
	writeFileSync(`${destination}.sha256`, `${checksum}  ${filename}\n`);
	process.stdout.write(`${destination}\n${checksum}  ${filename}\n`);
}

const { target, output } = parseArgs();
const configuration = targets[target];
const temporary = resolve(tmpdir(), `3xhaustpi-native-${process.pid}-${Date.now()}`);
const stagingParent = join(temporary, "staging");
const staging = join(stagingParent, "3xhaustpi");

try {
	mkdirSync(join(staging, "runtime"), { recursive: true });
	const nodeArchive = join(temporary, configuration.nodeName);
	const pythonArchive = join(temporary, configuration.pythonName);
	await Promise.all([
		download(
			`https://nodejs.org/download/release/v${nodeVersion}/${configuration.nodeName}`,
			nodeArchive,
			configuration.nodeSha256,
		),
		download(
			`https://github.com/astral-sh/python-build-standalone/releases/download/${pythonRelease}/${encodeURIComponent(configuration.pythonName)}`,
			pythonArchive,
			configuration.pythonSha256,
		),
	]);
	if (configuration.nodeName.endsWith(".zip")) extractZip(nodeArchive, join(staging, "runtime", "node"));
	else extractTar(nodeArchive, join(staging, "runtime", "node"));
	extractTar(pythonArchive, join(staging, "runtime", "python"));
	installApplication(staging, temporary, configuration.keyringPackage);
	writeLaunchers(staging, target);
	writeManifest(staging, target);
	createArchive(stagingParent, target, output, configuration.archive);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
