import { DesktopAccessibilityHost } from "../../dist/desktop-runtime.js";

const pid = Number.parseInt(process.env.X3HAUSTPI_FIXTURE_PID ?? "", 10);
if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("X3HAUSTPI_FIXTURE_PID is invalid");
const host = new DesktopAccessibilityHost({ timeoutMs: 15_000 });
let listed = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
	const applications = await host.listApplications();
	listed = applications.applications.some((application) => application.pid === pid);
	if (listed) break;
	await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!listed) throw new Error("GTK fixture was not listed by AT-SPI");
const observation = await host.observe({ pid });
const button = observation.elements.find((element) => element.role === "button" && element.name === "Run");
if (!button) throw new Error(`Run button was not observed: ${JSON.stringify(observation.elements)}`);
const action = await host.act(
	{ pid },
	{
		action: "click",
		target: { ...button, observationDigest: observation.digest },
		button: "left",
	},
);
await new Promise((resolve) => setTimeout(resolve, 250));
const after = await host.observe({ pid });
if (!after.elements.some((element) => element.role === "button" && element.name === "Completed")) {
	throw new Error(`Completed button state was not observed: ${JSON.stringify(after.elements)}`);
}
process.stdout.write(
	`${JSON.stringify(
		{
			platform: `linux-${process.arch}`,
			fixturePid: pid,
			listed,
			observedElements: observation.elements.length,
			observationDigest: observation.digest,
			postActionDigest: after.digest,
			digestChanged: observation.digest !== after.digest,
			action,
		},
		null,
		2,
	)}\n`,
);
