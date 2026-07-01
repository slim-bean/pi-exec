import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { jobDetail, jobLine, statusLabel } from "./format.js";
import type { ProcManager } from "./manager.js";

const SUBCOMMANDS = ["list", "start", "logs", "stop", "stopall", "wait"] as const;

const USAGE = [
	"/proc list                       list background jobs",
	"/proc start <command>            start a background job",
	"/proc logs <id> [tail]           show job output (optionally last N lines)",
	"/proc stop <id> [signal]         stop a job (SIGTERM then SIGKILL)",
	"/proc stopall                    stop every job",
	"/proc wait <id> [pattern]        wait for exit or a matching output line",
].join("\n");

export function registerCommands(pi: ExtensionAPI, manager: ProcManager): void {
	pi.registerCommand("proc", {
		description: "Manage session-scoped background processes",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const parts = prefix.split(/\s+/);
			// Completing the subcommand.
			if (parts.length <= 1) {
				const items = SUBCOMMANDS.filter((s) => s.startsWith(parts[0] ?? "")).map((s) => ({ value: s, label: s }));
				return items.length > 0 ? items : null;
			}
			// Completing a job id for id-taking subcommands.
			const sub = parts[0];
			if (["logs", "stop", "wait"].includes(sub)) {
				const idPrefix = parts[parts.length - 1];
				const items = manager
					.list()
					.filter((j) => j.id.startsWith(idPrefix))
					.map((j) => ({ value: `${sub} ${j.id}`, label: jobLine(j) }));
				return items.length > 0 ? items : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [sub, ...rest] = trimmed.split(/\s+/);
			const restStr = trimmed.slice(sub.length).trim();

			switch (sub || "list") {
				case "list":
					return runList(manager, ctx);
				case "start":
					return runStart(manager, ctx, restStr);
				case "logs":
					return runLogs(manager, ctx, rest);
				case "stop":
					return runStop(manager, ctx, rest);
				case "stopall":
					return runStopAll(manager, ctx);
				case "wait":
					return runWait(manager, ctx, rest);
				default:
					ctx.ui.notify(`Unknown subcommand '${sub}'.\n${USAGE}`, "warning");
			}
		},
	});
}

function runList(manager: ProcManager, ctx: ExtensionCommandContext): void {
	const jobs = manager.list();
	if (jobs.length === 0) {
		ctx.ui.notify("No background processes.", "info");
		return;
	}
	ctx.ui.notify(jobs.map(jobLine).join("\n"), "info");
}

function runStart(manager: ProcManager, ctx: ExtensionCommandContext, command: string): void {
	if (!command) {
		ctx.ui.notify("Usage: /proc start <command>", "warning");
		return;
	}
	const job = manager.start({ command, cwd: ctx.cwd });
	ctx.ui.notify(`Started ${job.id} (pid ${job.pid ?? "?"}): ${command}`, "info");
}

function runLogs(manager: ProcManager, ctx: ExtensionCommandContext, rest: string[]): void {
	const id = rest[0];
	if (!id) {
		ctx.ui.notify("Usage: /proc logs <id> [tail]", "warning");
		return;
	}
	const job = manager.get(id);
	if (!job) {
		ctx.ui.notify(`No such job: ${id}`, "warning");
		return;
	}
	const tail = rest[1] ? Number.parseInt(rest[1], 10) : 40;
	const output = manager.logs(id, { tail: Number.isFinite(tail) ? tail : 40 });
	ctx.ui.notify(`${jobDetail(job)}\n\n${output || "(no output)"}`, "info");
}

async function runStop(manager: ProcManager, ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
	const id = rest[0];
	if (!id) {
		ctx.ui.notify("Usage: /proc stop <id> [signal]", "warning");
		return;
	}
	const job = manager.get(id);
	if (!job) {
		ctx.ui.notify(`No such job: ${id}`, "warning");
		return;
	}
	if (job.status !== "running") {
		ctx.ui.notify(`${id} already ${statusLabel(job)}.`, "info");
		return;
	}
	await manager.stop(id, { signal: rest[1] as NodeJS.Signals | undefined });
	const after = manager.get(id);
	ctx.ui.notify(`Stopped ${id}: ${after ? statusLabel(after) : "gone"}.`, "info");
}

async function runStopAll(manager: ProcManager, ctx: ExtensionCommandContext): Promise<void> {
	const running = manager.list().filter((j) => j.status === "running");
	if (running.length === 0) {
		ctx.ui.notify("No running processes to stop.", "info");
		return;
	}
	await Promise.all(running.map((j) => manager.stop(j.id)));
	ctx.ui.notify(`Stopped ${running.length} process(es).`, "info");
}

async function runWait(manager: ProcManager, ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
	const id = rest[0];
	if (!id) {
		ctx.ui.notify("Usage: /proc wait <id> [pattern]", "warning");
		return;
	}
	if (!manager.get(id)) {
		ctx.ui.notify(`No such job: ${id}`, "warning");
		return;
	}
	const pattern = rest.slice(1).join(" ") || undefined;
	ctx.ui.notify(`Waiting on ${id}${pattern ? ` for /${pattern}/` : ""}…`, "info");
	const result = await manager.wait(id, { pattern, timeoutMs: 120_000 });
	const desc =
		result.reason === "match"
			? `matched: ${result.matchedLine}`
			: result.reason === "timeout"
				? "timed out"
				: statusLabel(result.job);
	ctx.ui.notify(`${id} ${result.reason}: ${desc}`, "info");
}
