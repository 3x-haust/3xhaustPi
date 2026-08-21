let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	body += chunk;
});
process.stdin.on("end", () => {
	const request = JSON.parse(body);
	const platform = process.env.X3HAUSTPI_FIXTURE_PLATFORM;
	if (platform !== "win32" && platform !== "linux") throw new Error("fixture platform is invalid");
	if (request.operation === "list") {
		process.stdout.write(
			JSON.stringify({
				platform,
				trusted: true,
				applications: [
					{ pid: 4242, name: "Fixture Editor", bundleId: `${platform}:fixture`, active: true },
				],
			}),
		);
		return;
	}
	if (request.operation === "observe") {
		process.stdout.write(
			JSON.stringify({
				application: { pid: 4242, name: "Fixture Editor", frontmost: true },
				trusted: true,
				elements: [
					{ role: "button", name: "Run", path: [0] },
					{ role: "field", name: "Query", path: [1] },
				],
			}),
		);
		return;
	}
	if (request.operation === "perform") {
		if (request.expected?.name !== "Run" || request.path?.[0] !== 0) {
			throw new Error("fixture received a stale semantic path");
		}
		process.stdout.write(JSON.stringify({ method: request.coordinateFallback ? "coordinates" : "accessibility" }));
		return;
	}
	throw new Error("fixture operation is invalid");
});
