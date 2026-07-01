/**
 * proc-manager — session-scoped background process manager for pi.
 *
 * Registers tools (proc_start/list/logs/stop/wait) the LLM can call and a
 * `/proc` command for manual use. Every process is spawned as a group leader
 * and tracked; all are terminated when the session ends.
 *
 * Lifetime guarantee: jobs live ONLY as long as the pi session. Cleanup runs
 * from `session_shutdown` (graceful) with a synchronous `process.exit` safety
 * net (last-resort SIGKILL). The only case not covered is `kill -9` of pi
 * itself, where no process can run cleanup.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { jobLine, statusLabel } from "./format.js";
import { ProcManager } from "./manager.js";
import { registerCommands } from "./commands.js";
import { registerTools } from "./tools.js";
import type { JobSummary } from "./types.js";

const WIDGET_ID = "proc-manager";

export default function procManagerExtension(pi: ExtensionAPI) {
	// Constructing the manager has no side effects (no temp dir, no processes)
	// until the first job starts, so it is safe to create at factory time.
	const manager = new ProcManager();

	registerTools(pi, manager);
	registerCommands(pi, manager);

	let uiCtx: ExtensionContext | undefined;
	// Last-resort synchronous kill if pi exits without emitting session_shutdown.
	const onProcExit = () => manager.killAllSync();

	const refreshWidget = () => {
		if (!uiCtx?.hasUI) return;
		const running = manager.list().filter((j) => j.status === "running");
		uiCtx.ui.setWidget(WIDGET_ID, running.map(jobLine));
	};

	const onExitEvent = (job: JobSummary) => {
		refreshWidget();
		if (!uiCtx?.hasUI) return;
		const level = job.status === "exited" && job.exitCode === 0 ? "info" : "warning";
		uiCtx.ui.notify(`${job.id} ${statusLabel(job)}`, level);
	};

	// Watched jobs that die unexpectedly proactively tell the agent, which can
	// then decide to inspect logs or restart. Delivered as a follow-up so it
	// doesn't interrupt an in-progress turn.
	const onCrash = (job: JobSummary) => {
		const label = job.name ? `${job.id} (${job.name})` : job.id;
		pi.sendMessage(
			{
				customType: "proc-manager",
				content:
					`Watched background job ${label} ${statusLabel(job)} unexpectedly.\n` +
					`Command: ${job.command}\n` +
					`Use proc_logs("${job.id}") to inspect output, or proc_restart("${job.id}") to relaunch it.`,
				display: true,
				details: { job },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	manager.on("change", refreshWidget);
	manager.on("exit", onExitEvent);
	manager.on("crash", onCrash);

	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx;
		process.on("exit", onProcExit);
		refreshWidget();
	});

	pi.on("session_shutdown", async () => {
		process.off("exit", onProcExit);
		await manager.stopAll();
		uiCtx?.ui.setWidget(WIDGET_ID, []);
		uiCtx = undefined;
	});
}
