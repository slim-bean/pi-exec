import type { JobSummary } from "./types.js";

export function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}

export function statusLabel(job: JobSummary): string {
	switch (job.status) {
		case "running":
			return "running";
		case "killed":
			return `killed${job.signal ? ` (${job.signal})` : ""}`;
		case "exited":
			return `exited (code ${job.exitCode ?? "?"})`;
	}
}

/** One compact line describing a job, e.g. for the TUI widget. */
export function jobLine(job: JobSummary): string {
	const label = job.name ? `${job.id} ${job.name}` : job.id;
	const dot = job.status === "running" ? "●" : "○";
	return `${dot} ${label} · ${statusLabel(job)} · ${formatDuration(job.uptimeMs)} · ${truncate(job.command, 48)}`;
}

/** A fuller multi-line description for tool/command output. */
export function jobDetail(job: JobSummary): string {
	const lines = [
		`${job.id}${job.name ? ` (${job.name})` : ""}`,
		`  status:  ${statusLabel(job)}`,
		`  pid:     ${job.pid ?? "?"}`,
		`  uptime:  ${formatDuration(job.uptimeMs)}`,
		`  cwd:     ${job.cwd}`,
		`  command: ${job.command}`,
	];
	return lines.join("\n");
}

export function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
