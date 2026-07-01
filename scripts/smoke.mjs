// Runtime smoke test for ProcManager. Run: node scripts/smoke.mjs
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const { ProcManager } = await jiti.import("../.pi/extensions/proc-manager/manager.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const m = new ProcManager();
let failures = 0;
const check = (name, cond) => {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failures++;
};

// 1. start + capture output + wait for match
const j1 = m.start({ command: "echo hello-world; sleep 30", cwd: process.cwd(), name: "echoer" });
check("start returns running job with pid", j1.status === "running" && typeof j1.pid === "number");

const match = await m.wait(j1.id, { pattern: "hello", timeoutMs: 5000 });
check("wait resolves on output match", match.reason === "match" && /hello/.test(match.matchedLine));
check("logs contain output", m.logs(j1.id).includes("hello-world"));

// 2. grandchild group kill: shell spawns a sleep; killing the group must reap it.
const j2 = m.start({ command: "sleep 60 & echo child-pid $!; wait", cwd: process.cwd() });
await m.wait(j2.id, { pattern: "child-pid", timeoutMs: 5000 });
const childPid = Number(m.logs(j2.id).match(/child-pid (\d+)/)?.[1]);
check("captured grandchild pid", Number.isFinite(childPid) && alive(childPid));

await m.stop(j2.id);
await sleep(300);
check("stop reaps the whole process group (grandchild dead)", !alive(childPid));
check("job2 marked killed/exited", m.get(j2.id).status !== "running");

// 3. restart reuses the id and relaunches
const j3 = m.start({ command: "echo boot; sleep 30", cwd: process.cwd(), name: "svc" });
await m.wait(j3.id, { pattern: "boot", timeoutMs: 5000 });
const oldPid = m.get(j3.id).pid;
const restarted = await m.restart(j3.id);
check("restart keeps id, new pid, running", restarted.id === j3.id && restarted.pid !== oldPid && restarted.status === "running");
await sleep(200);
check("old pid gone after restart", !alive(oldPid));

// 4. watched crash emits a 'crash' event; intentional stop does not
let crashed = null;
m.on("crash", (job) => {
	crashed = job;
});
const j4 = m.start({ command: "echo bye; exit 7", cwd: process.cwd(), watch: true });
await m.wait(j4.id, { timeoutMs: 5000 });
await sleep(100);
check("watched non-zero exit emits crash", crashed?.id === j4.id && crashed.exitCode === 7);

crashed = null;
const j5 = m.start({ command: "sleep 30", cwd: process.cwd(), watch: true });
await m.stop(j5.id);
await sleep(200);
check("intentional stop of watched job does NOT crash", crashed === null);

// 5. killAllSync last-resort path
const before = m.get(j3.id).pid;
m.killAllSync();
await sleep(300);
check("killAllSync terminates remaining jobs", !alive(before));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
