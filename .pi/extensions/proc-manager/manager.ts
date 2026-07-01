import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	appendFileSync,
	createWriteStream,
	mkdtempSync,
	readFileSync,
	rmSync,
	type WriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, JobSummary, LogOptions, StartOptions, StopOptions, WaitOptions, WaitResult } from "./types.js";

const MAX_RING_LINES = 1000;

function toSummary(job: Job): JobSummary {
	return {
		id: job.id,
		name: job.name,
		command: job.command,
		cwd: job.cwd,
		pid: job.pid,
		status: job.status,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		uptimeMs: (job.endedAt ?? Date.now()) - job.startedAt,
		exitCode: job.exitCode,
		signal: job.signal,
		logFile: job.logFile,
	};
}

/**
 * Manages session-scoped background processes.
 *
 * Safety contract: every process this manager spawns is a group leader
 * (detached) and is tracked in `jobs`. `stopAll()` (async, graceful) and
 * `killAllSync()` (last-resort, synchronous) both terminate the ENTIRE
 * process group so no grandchildren are orphaned. The owning extension must
 * call `stopAll()` from `session_shutdown` and register `killAllSync()` as a
 * process `exit` safety net.
 */
export class ProcManager extends EventEmitter {
	private readonly jobs = new Map<string, Job>();
	private readonly streams = new Map<string, WriteStream>();
	private counter = 0;
	private disposed = false;
	private logDir: string | undefined;

	/** Create the temp log dir lazily so constructing the manager has no side effects. */
	private ensureDir(): string {
		if (!this.logDir) this.logDir = mkdtempSync(join(tmpdir(), "pi-proc-"));
		return this.logDir;
	}

	start(opts: StartOptions): JobSummary {
		if (this.disposed) throw new Error("ProcManager has been disposed");

		const id = `p${++this.counter}`;
		const job: Job = {
			id,
			name: opts.name,
			command: opts.command,
			cwd: opts.cwd,
			env: opts.env,
			watch: opts.watch,
			startedAt: Date.now(),
			status: "running",
			exitCode: null,
			signal: null,
			logFile: join(this.ensureDir(), `${id}.log`),
			ring: [],
			// Assigned synchronously by spawnJob below.
			child: undefined as unknown as ChildProcess,
		};
		this.jobs.set(id, job);
		this.spawnJob(job);
		this.emit("change");
		return toSummary(job);
	}

	/**
	 * Re-launch a job under its original id, preserving command, cwd, env, and
	 * watch flag. Stops it first if still running.
	 */
	async restart(id: string): Promise<JobSummary | undefined> {
		const job = this.jobs.get(id);
		if (!job || this.disposed) return undefined;
		if (job.status === "running") await this.stop(id);

		this.note(job, `\n--- restart ${new Date().toISOString()} ---\n`);
		job.startedAt = Date.now();
		job.endedAt = undefined;
		job.status = "running";
		job.exitCode = null;
		job.signal = null;
		job.ring = [];
		job._stopping = false;
		job._lastLineComplete = undefined;
		this.spawnJob(job);
		this.emit("change");
		return toSummary(job);
	}

	/** Spawn (or re-spawn) the OS process for a job and wire up its streams. */
	private spawnJob(job: Job): void {
		const stream = createWriteStream(job.logFile, { flags: "a" });
		const child: ChildProcess = spawn(job.command, {
			cwd: job.cwd,
			shell: true,
			// Own process group so we can signal the whole tree via -pid.
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...job.env },
		});
		// Don't keep pi's event loop alive; we still hold the handle to kill it.
		child.unref();
		job.child = child;
		job.pid = child.pid;
		this.streams.set(job.id, stream);

		const onData = (chunk: Buffer) => this.ingest(job, chunk.toString());
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);

		child.on("error", (err) => {
			this.ingest(job, `[proc-manager] spawn error: ${err.message}\n`);
			this.finalize(job, null, null);
		});
		child.on("exit", (code, signal) => this.finalize(job, code, signal));
	}

	private ingest(job: Job, text: string): void {
		this.streams.get(job.id)?.write(text);
		const lines = text.split("\n");
		// Merge continuation into the last ring line when text doesn't start fresh.
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (i === 0 && job.ring.length > 0 && !job._lastLineComplete) {
				job.ring[job.ring.length - 1] += line;
			} else if (i < lines.length - 1 || line.length > 0) {
				job.ring.push(line);
			}
		}
		job._lastLineComplete = text.endsWith("\n");
		if (job.ring.length > MAX_RING_LINES) {
			job.ring.splice(0, job.ring.length - MAX_RING_LINES);
		}
		this.emit("data", job.id, text);
	}

	private finalize(job: Job, code: number | null, signal: NodeJS.Signals | null): void {
		if (job.status !== "running") return;
		job.status = signal && code === null ? "killed" : "exited";
		job.exitCode = code;
		job.signal = signal;
		job.endedAt = Date.now();
		const stream = this.streams.get(job.id);
		if (stream) {
			stream.end();
			this.streams.delete(job.id);
		}
		const summary = toSummary(job);
		this.emit("exit", summary);
		// A crash is an unexpected exit we did not request: non-zero code or a
		// terminating signal we didn't send via stop().
		if (job.watch && !job._stopping && (job.status === "killed" || (job.exitCode ?? 0) !== 0)) {
			this.emit("crash", summary);
		}
		this.emit("change");
	}

	get(id: string): JobSummary | undefined {
		const job = this.jobs.get(id);
		return job ? toSummary(job) : undefined;
	}

	list(): JobSummary[] {
		return [...this.jobs.values()].map(toSummary);
	}

	logs(id: string, opts: LogOptions = {}): string {
		const job = this.jobs.get(id);
		if (!job) return "";
		// Prefer the on-disk log so we get full history beyond the ring buffer.
		let lines: string[];
		try {
			lines = readFileSync(job.logFile, "utf8").split("\n");
			if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		} catch {
			lines = [...job.ring];
		}
		if (opts.grep) {
			const re = safeRegex(opts.grep);
			lines = lines.filter((l) => re.test(l));
		}
		if (opts.tail && opts.tail > 0) {
			lines = lines.slice(-opts.tail);
		}
		return lines.join("\n");
	}

	/** Gracefully stop a single job, escalating to SIGKILL after graceMs. */
	async stop(id: string, opts: StopOptions = {}): Promise<boolean> {
		const job = this.jobs.get(id);
		if (!job || job.status !== "running") return false;
		const signal = opts.signal ?? "SIGTERM";
		const graceMs = opts.graceMs ?? 3000;
		// Mark as an intentional stop so finalize() doesn't report a crash.
		job._stopping = true;

		const exited = new Promise<void>((resolve) => {
			if (job.status !== "running") return resolve();
			job.child.once("exit", () => resolve());
		});

		this.signalGroup(job, signal);

		const escalated = await Promise.race([
			exited.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
		]);
		if (!escalated && job.status === "running") {
			this.signalGroup(job, "SIGKILL");
			await exited;
		}
		return true;
	}

	/**
	 * Resolve when the job exits, an output line matches `pattern`, the
	 * timeout elapses, or the abort signal fires.
	 */
	wait(id: string, opts: WaitOptions = {}): Promise<WaitResult> {
		const job = this.jobs.get(id);
		if (!job) return Promise.reject(new Error(`No such job: ${id}`));

		return new Promise<WaitResult>((resolve, reject) => {
			const re = opts.pattern ? safeRegex(opts.pattern) : undefined;
			let done = false;
			const cleanup = () => {
				this.off("data", onData);
				this.off("exit", onExit);
				if (timer) clearTimeout(timer);
				opts.signal?.removeEventListener("abort", onAbort);
			};
			const settle = (fn: () => void) => {
				if (done) return;
				done = true;
				cleanup();
				fn();
			};

			// Already exited before we started waiting.
			if (job.status !== "running") {
				return resolve({ reason: "exit", job: toSummary(job) });
			}

			const onData = (jobId: string, text: string) => {
				if (jobId !== id || !re) return;
				for (const line of text.split("\n")) {
					if (line && re.test(line)) {
						return settle(() => resolve({ reason: "match", job: toSummary(job), matchedLine: line }));
					}
				}
			};
			const onExit = (summary: JobSummary) => {
				if (summary.id !== id) return;
				settle(() => resolve({ reason: "exit", job: summary }));
			};
			const onAbort = () => settle(() => reject(new Error("wait aborted")));

			const timer = opts.timeoutMs
				? setTimeout(() => settle(() => resolve({ reason: "timeout", job: toSummary(job) })), opts.timeoutMs)
				: undefined;

			this.on("data", onData);
			this.on("exit", onExit);
			opts.signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** Send `signal` to the whole process group of a job. */
	private signalGroup(job: Job, signal: NodeJS.Signals): void {
		if (job.pid == null) return;
		try {
			// Negative pid targets the process group (child was spawned detached).
			process.kill(-job.pid, signal);
		} catch {
			// Fall back to the direct pid if the group is already gone.
			try {
				job.child.kill(signal);
			} catch {
				/* already dead */
			}
		}
	}

	/** Graceful async teardown of every job. Idempotent. */
	async stopAll(opts: StopOptions = {}): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const running = [...this.jobs.values()].filter((j) => j.status === "running");
		await Promise.all(running.map((j) => this.stop(j.id, opts)));
		this.cleanupDir();
	}

	/**
	 * Last-resort SYNCHRONOUS kill for use in a process `exit` handler where
	 * async work cannot run. SIGKILLs every tracked process group.
	 */
	killAllSync(): void {
		for (const job of this.jobs.values()) {
			if (job.status === "running" && job.pid != null) {
				try {
					process.kill(-job.pid, "SIGKILL");
				} catch {
					/* ignore */
				}
			}
		}
		this.cleanupDir();
	}

	private cleanupDir(): void {
		for (const stream of this.streams.values()) stream.end();
		this.streams.clear();
		if (!this.logDir) return;
		try {
			rmSync(this.logDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	/** Append a manager-level note to a job's log (used for diagnostics). */
	note(job: Job, text: string): void {
		try {
			appendFileSync(job.logFile, text);
		} catch {
			/* ignore */
		}
	}
}

function safeRegex(pattern: string): RegExp {
	try {
		return new RegExp(pattern, "i");
	} catch {
		// Treat as a literal substring if it isn't a valid regex.
		return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
	}
}
