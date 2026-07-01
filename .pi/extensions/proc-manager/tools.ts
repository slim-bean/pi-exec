import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { jobLine, statusLabel } from "./format.js";
import type { ProcManager } from "./manager.js";
import type { JobSummary } from "./types.js";

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function summaryList(jobs: JobSummary[]): string {
	if (jobs.length === 0) return "No background processes.";
	return jobs.map(jobLine).join("\n");
}

export function registerTools(pi: ExtensionAPI, manager: ProcManager): void {
	pi.registerTool({
		name: "proc_start",
		label: "Start Process",
		description:
			"Start a shell command as a session-scoped background process and return its job id immediately. " +
			"Use this for long-running tasks (dev servers, watchers, tail -f) instead of the bash tool, which blocks until completion. " +
			"Output is captured; inspect it later with proc_logs. All jobs are killed when the pi session ends.",
		promptSnippet: "Run a long-lived command in the background and return a job id",
		promptGuidelines: [
			"Use proc_start for long-running commands (servers, watchers) so the turn is not blocked; use bash for commands that finish quickly.",
			"After proc_start, use proc_logs to read output and proc_wait to block until a server is ready or a job exits.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run in the background." }),
			name: Type.Optional(Type.String({ description: "Optional friendly name for the job." })),
			cwd: Type.Optional(Type.String({ description: "Working directory (defaults to the session cwd)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const job = manager.start({
				command: params.command,
				name: params.name,
				cwd: params.cwd ?? ctx.cwd,
			});
			return textResult(`Started ${job.id} (pid ${job.pid ?? "?"}): ${params.command}`, { job });
		},
	});

	pi.registerTool({
		name: "proc_list",
		label: "List Processes",
		description: "List all background processes started this session, with status, pid, and uptime.",
		promptSnippet: "List background processes and their status",
		parameters: Type.Object({}),
		async execute() {
			const jobs = manager.list();
			return textResult(summaryList(jobs), { jobs });
		},
	});

	pi.registerTool({
		name: "proc_logs",
		label: "Process Logs",
		description: "Fetch captured stdout/stderr output for a background job.",
		promptSnippet: "Read captured output from a background job",
		parameters: Type.Object({
			id: Type.String({ description: "Job id, e.g. 'p1'." }),
			tail: Type.Optional(Type.Number({ description: "Return only the last N lines." })),
			grep: Type.Optional(Type.String({ description: "Filter to lines matching this (case-insensitive) pattern." })),
		}),
		async execute(_id, params) {
			const job = manager.get(params.id);
			if (!job) return textResult(`No such job: ${params.id}`, { error: "not_found" });
			const output = manager.logs(params.id, { tail: params.tail, grep: params.grep });
			const header = `${job.id} — ${statusLabel(job)}`;
			return textResult(`${header}\n${output || "(no output)"}`, { job, output });
		},
	});

	pi.registerTool({
		name: "proc_stop",
		label: "Stop Process",
		description:
			"Stop a background job. Sends SIGTERM (or a given signal) to the whole process group, escalating to SIGKILL if it does not exit.",
		promptSnippet: "Stop a background job",
		parameters: Type.Object({
			id: Type.String({ description: "Job id, e.g. 'p1'." }),
			signal: Type.Optional(Type.String({ description: "Signal to send first (default SIGTERM)." })),
		}),
		async execute(_id, params) {
			const job = manager.get(params.id);
			if (!job) return textResult(`No such job: ${params.id}`, { error: "not_found" });
			if (job.status !== "running") return textResult(`${job.id} already ${statusLabel(job)}.`, { job });
			await manager.stop(params.id, { signal: params.signal as NodeJS.Signals | undefined });
			const after = manager.get(params.id);
			return textResult(`Stopped ${params.id}: ${after ? statusLabel(after) : "gone"}.`, { job: after });
		},
	});

	pi.registerTool({
		name: "proc_wait",
		label: "Wait For Process",
		description:
			"Block until a background job exits, an output line matches a pattern, or a timeout elapses. " +
			"Useful to wait for a server to print a 'ready' line before proceeding.",
		promptSnippet: "Wait for a job to exit or print a matching line",
		parameters: Type.Object({
			id: Type.String({ description: "Job id, e.g. 'p1'." }),
			pattern: Type.Optional(Type.String({ description: "Resolve when an output line matches this pattern." })),
			timeout_ms: Type.Optional(Type.Number({ description: "Resolve with 'timeout' after this many ms." })),
		}),
		async execute(_id, params, signal) {
			const job = manager.get(params.id);
			if (!job) return textResult(`No such job: ${params.id}`, { error: "not_found" });
			try {
				const result = await manager.wait(params.id, {
					pattern: params.pattern,
					timeoutMs: params.timeout_ms,
					signal,
				});
				const desc =
					result.reason === "match"
						? `matched: ${result.matchedLine}`
						: result.reason === "timeout"
							? "timed out"
							: statusLabel(result.job);
				return textResult(`${params.id} ${result.reason}: ${desc}`, { result });
			} catch (err) {
				return textResult(`Wait cancelled: ${(err as Error).message}`, { error: "aborted" });
			}
		},
	});
}
