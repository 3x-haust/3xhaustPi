import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	runSelfUpdate,
	type SelfUpdateDependencies,
	verifyRegistrySignature,
	verifyTarballIntegrity,
} from "../src/self-update.ts";

describe("self-update verification", () => {
	it("accepts only the exact registry tarball integrity", () => {
		const tarball = Buffer.from("verified 3xhaustpi archive");
		const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
		expect(verifyTarballIntegrity(tarball, integrity)).toBe(true);
		expect(verifyTarballIntegrity(Buffer.from("tampered"), integrity)).toBe(false);
		expect(verifyTarballIntegrity(tarball, "md5-unsupported")).toBe(false);
	});

	it("verifies the signed package name, version, and integrity tuple", () => {
		const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const integrity = "sha512-fixture";
		const message = Buffer.from(`3xhaustpi@1.2.3:${integrity}`);
		const signature = sign("sha256", message, privateKey).toString("base64");
		const key = publicKey.export({ format: "der", type: "spki" }).toString("base64");
		const metadata = {
			name: "3xhaustpi",
			version: "1.2.3",
			dist: {
				integrity,
				tarball: "https://registry.npmjs.org/3xhaustpi/-/3xhaustpi-1.2.3.tgz",
				signatures: [{ keyid: "SHA256:fixture", sig: signature }],
			},
		};
		const keys = [
			{
				keyid: "SHA256:fixture",
				keytype: "ecdsa-sha2-nistp256",
				scheme: "ecdsa-sha2-nistp256",
				key,
				expires: null,
			},
		];

		expect(verifyRegistrySignature(metadata, keys)).toBe(true);
		expect(verifyRegistrySignature({ ...metadata, version: "1.2.4" }, keys)).toBe(false);
		expect(verifyRegistrySignature(metadata, [{ ...keys[0]!, expires: "2000-01-01T00:00:00.000Z" }])).toBe(false);
	});

	it("restores the previous global package when the installed update reports the wrong version", async () => {
		const tarball = Buffer.from("signed update archive");
		const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
		const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const signature = sign("sha256", Buffer.from(`3xhaustpi@0.2.0:${integrity}`), privateKey).toString("base64");
		const metadata = {
			name: "3xhaustpi",
			version: "0.2.0",
			dist: {
				integrity,
				tarball: "https://registry.npmjs.org/3xhaustpi/-/3xhaustpi-0.2.0.tgz",
				signatures: [{ keyid: "SHA256:fixture", sig: signature }],
			},
		};
		const keyResponse = {
			keys: [
				{
					keyid: "SHA256:fixture",
					keytype: "ecdsa-sha2-nistp256",
					scheme: "ecdsa-sha2-nistp256",
					key: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
					expires: null,
				},
			],
		};
		let installedVersion = "0.1.0";
		const installHistory: string[] = [];
		const dependencies: SelfUpdateDependencies = {
			fetchJson: async <T>(url: string) => (url.endsWith("/latest") ? metadata : keyResponse) as T,
			fetchBytes: async () => tarball,
			packageRoot: () => "/fixture/current-install",
			executablePath: () => "/fixture/bin/3xhaustpi",
			log: () => undefined,
			spawn: (command, args) => {
				if (command === "npm" && args[0] === "pack") {
					const destination = args.at(-1);
					if (!destination) throw new Error("missing pack destination");
					writeFileSync(join(destination, "3xhaustpi-0.1.0.tgz"), "rollback");
					return basename(join(destination, "3xhaustpi-0.1.0.tgz"));
				}
				if (command === "npm" && args[0] === "install") {
					const archive = args.at(-1);
					if (!archive) throw new Error("missing install archive");
					installHistory.push(archive);
					installedVersion = archive.includes("rollback") ? "0.1.0" : "broken-update";
					return "";
				}
				if (command === "/fixture/bin/3xhaustpi" && args[0] === "--version") return installedVersion;
				throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
			},
		};

		await expect(runSelfUpdate("0.1.0", dependencies)).rejects.toThrow(
			"Updated executable reported broken-update instead of 0.2.0",
		);
		expect(installedVersion).toBe("0.1.0");
		expect(installHistory).toHaveLength(2);
		expect(installHistory[1]).toContain("/rollback/");
	});
});
