export type DesktopAccessibilityRole = "button" | "link" | "field" | "menu-item" | "window";
export interface DesktopApplication {
	readonly pid: number;
	readonly name: string;
	readonly bundleId: string;
	readonly active: boolean;
}
export interface DesktopApplicationTarget {
	readonly pid: number;
}
export interface DesktopAccessibilityElement {
	readonly role: DesktopAccessibilityRole;
	readonly name: string;
}
export interface DesktopAccessibilityObservation {
	readonly application: { readonly pid: number; readonly name: string; readonly frontmost: boolean };
	readonly digest: string;
	readonly capturedAt: string;
	readonly durationMs: number;
	readonly elements: readonly DesktopAccessibilityElement[];
}
export type DesktopComputerAction =
	| {
			readonly action: "click";
			readonly target: DesktopAccessibilityElement & { readonly observationDigest: string };
			readonly coordinates?: { readonly x: number; readonly y: number };
			readonly button: "left" | "right" | "middle";
			readonly approvalDigest?: string;
	  }
	| {
			readonly action: "type";
			readonly target: DesktopAccessibilityElement & { readonly observationDigest: string };
			readonly text: string;
			readonly approvalDigest?: string;
	  }
	| {
			readonly action: "key";
			readonly target: DesktopAccessibilityElement & { readonly observationDigest: string };
			readonly key: "Enter" | "Escape" | "Tab" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";
			readonly approvalDigest?: string;
	  }
	| {
			readonly action: "scroll";
			readonly target: DesktopAccessibilityElement & { readonly observationDigest: string };
			readonly deltaY: number;
			readonly approvalDigest?: string;
	  };
export interface DesktopActionResult {
	readonly method: "accessibility" | "coordinates";
	readonly digest: string;
	readonly completedAt: string;
	readonly durationMs: number;
}
export type DesktopAccessibilityPlatform = "darwin" | "win32" | "linux";
export interface DesktopHelperRuntime {
	readonly platform: DesktopAccessibilityPlatform;
	readonly command: string;
	readonly args: readonly string[];
	readonly helper: string;
	readonly env?: Readonly<Record<string, string>>;
}
export function desktopComputerUseStatus(): {
	readonly platform: NodeJS.Platform;
	readonly available: boolean;
	readonly helper: string;
};
export class DesktopAccessibilityHost {
	constructor(options?: { readonly timeoutMs?: number; readonly helperRuntime?: DesktopHelperRuntime });
	listApplications(signal?: AbortSignal): Promise<{
		readonly platform: DesktopAccessibilityPlatform;
		readonly trusted: boolean;
		readonly applications: readonly DesktopApplication[];
	}>;
	observe(
		target: DesktopApplicationTarget,
		options?: { readonly signal?: AbortSignal; readonly maxElements?: number },
	): Promise<DesktopAccessibilityObservation>;
	act(
		target: DesktopApplicationTarget,
		action: DesktopComputerAction,
		options?: { readonly signal?: AbortSignal; readonly approvedCoordinateDigest?: string },
	): Promise<DesktopActionResult>;
}
