import type { ChildProcess } from "node:child_process";

export type JobStatus = "running" | "exited" | "killed";

/** A single background process tracked by the manager. */
export interface Job {
	/** Short, friendly id (e.g. "p1"). */
	id: string;
	/** Optional human-readable name. */
	name?: string;
	/** The command string passed to the shell. */
	command: string;
	/** Working directory the command was launched in. */
	cwd: string;
	/** OS pid of the spawned shell (also the process-group id, since detached). */
	pid?: number;
	startedAt: number;
	endedAt?: number;
	status: JobStatus;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	/** Absolute path to the combined stdout/stderr log file. */
	logFile: string;
	/** In-memory ring buffer of the most recent output lines. */
	ring: string[];
	/** The underlying child process handle. */
	child: ChildProcess;
	/** Environment overrides used to launch (preserved across restart). */
	env?: Record<string, string>;
	/** Notify the agent if this job exits unexpectedly. */
	watch?: boolean;
	/** Internal: set when we deliberately stop the job (suppresses crash). */
	_stopping?: boolean;
	/** Internal: whether the last ingested chunk ended on a line boundary. */
	_lastLineComplete?: boolean;
}

/** Plain, serializable view of a job (no live handles). */
export interface JobSummary {
	id: string;
	name?: string;
	command: string;
	cwd: string;
	pid?: number;
	status: JobStatus;
	startedAt: number;
	endedAt?: number;
	uptimeMs: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	logFile: string;
}

export interface StartOptions {
	command: string;
	cwd: string;
	name?: string;
	env?: Record<string, string>;
	/** Notify the agent if this job exits unexpectedly. */
	watch?: boolean;
}

export interface LogOptions {
	/** Return only the last N lines. */
	tail?: number;
	/** Filter lines to those matching this (case-insensitive) substring/regex. */
	grep?: string;
}

export interface StopOptions {
	/** Signal to send first (default SIGTERM). */
	signal?: NodeJS.Signals;
	/** Escalate to SIGKILL after this many ms if still alive (default 3000). */
	graceMs?: number;
}

export type WaitReason = "exit" | "match" | "timeout";

export interface WaitOptions {
	/** Resolve when a new output line matches this pattern. */
	pattern?: string;
	/** Resolve with reason "timeout" after this many ms. */
	timeoutMs?: number;
	/** Abort signal (e.g. ctx.signal) to cancel the wait. */
	signal?: AbortSignal;
}

export interface WaitResult {
	reason: WaitReason;
	job: JobSummary;
	/** The line that matched, when reason === "match". */
	matchedLine?: string;
}
