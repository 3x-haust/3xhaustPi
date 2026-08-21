import { createCredentialStore } from "./provider-runtime.ts";

const providerId = process.argv[2];
if (!providerId || !/^[A-Za-z0-9._-]{1,128}$/u.test(providerId)) {
	throw new Error("A valid provider ID is required");
}

const credential = await createCredentialStore().read(providerId);
if (!credential) {
	process.exitCode = 3;
} else {
	process.stdout.write(JSON.stringify(credential));
}
