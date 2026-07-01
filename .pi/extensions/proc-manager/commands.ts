import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { jobDetail, jobLine, statusLabel } from "./format.js";
import type { ProcManager } from "./manager.js";
import type { CrashNotifyMode, ProcSettings } from "./types.js";

const SUBCOMMANDS = ["list", "start", "logs", "stop", "restart", "stopall", "wait", "notify"] as const;
const NOTIFY_MODES: CrashNotifyMode[] = ["interrupt", "next", "off"];

const USAGE = [
	"/proc list                       list background jobs",
	"/proc start <command>            start a background job",
	"/proc logs <id> [tail]           show job output (optionally last N lines)",
	"/proc stop <id> [signal]         stop a job (SIGTERM then SIGKILL)",
	"/proc restart <id>               restart a job with the same command",
	"/proc stopall                    stop every job",
	"/proc wait <id> [pattern]        wait for exit or a matching output line",
	"/proc notify [interrupt|next|off]  get/set watched-job crash notifications",
].join("\n");

export function registerCommands(pi: ExtensionAPI, manager: ProcManager, settings: ProcSettings): void {
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
			if (["logs", "stop", "restart", "wait"].includes(sub)) {
				const idPrefix = parts[parts.length - 1];
				const items = manager
					.list()
					.filter((j) => j.id.startsWith(idPrefix))
					.map((j) => ({ value: `${sub} ${j.id}`, label: jobLine(j) }));
				return items.length > 0 ? items : null;
			}
			if (sub === "notify") {
				const modePrefix = parts[parts.length - 1];
				const items = NOTIFY_MODES.filter((m) => m.startsWith(modePrefix)).map((m) => ({
					value: `notify ${m}`,
					label: m,
				}));
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
				case "restart":
					return runRestart(manager, ctx, rest);
				case "stopall":
					return runStopAll(manager, ctx);
				case "wait":
					return runWait(manager, ctx, rest);
				case "notify":
					return runNotify(settings, ctx, rest);
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

function runNotify(settings: ProcSettings, ctx: ExtensionCommandContext, rest: string[]): void {
	const mode = rest[0]?.toLowerCase();
	if (!mode) {
		ctx.ui.notify(
			`Crash notifications: ${settings.crashNotify}\n` +
				"interrupt = wake agent now · next = wait for your next prompt · off = don't notify",
			"info",
		);
		return;
	}
	if (!NOTIFY_MODES.includes(mode as CrashNotifyMode)) {
		ctx.ui.notify(`Usage: /proc notify [${NOTIFY_MODES.join("|")}]`, "warning");
		return;
	}
	settings.crashNotify = mode as CrashNotifyMode;
	ctx.ui.notify(`Crash notifications set to '${mode}'.`, "info");
}

async function runRestart(manager: ProcManager, ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
	const id = rest[0];
	if (!id) {
		ctx.ui.notify("Usage: /proc restart <id>", "warning");
		return;
	}
	if (!manager.get(id)) {
		ctx.ui.notify(`No such job: ${id}`, "warning");
		return;
	}
	const job = await manager.restart(id);
	ctx.ui.notify(job ? `Restarted ${job.id} (pid ${job.pid ?? "?"}): ${job.command}` : `Could not restart ${id}.`, "info");
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
