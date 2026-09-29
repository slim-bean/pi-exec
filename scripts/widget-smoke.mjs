// Widget lifecycle regression test. Run: node scripts/widget-smoke.mjs
import assert from "node:assert/strict";
import { mock } from "node:test";
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const { default: extension } = await jiti.import("../.pi/extensions/proc-manager/index.ts");
const handlers = new Map();
const tools = new Map();
let connected = false;
const widgets = [];
const ctx = {
	cwd: process.cwd(),
	get hasUI() { return connected; },
	ui: {
		setWidget(id, lines) { widgets.push({ id, lines }); },
		notify() {},
	},
};
const call = (name, params = {}) => tools.get(name).execute("test", params, undefined, undefined, ctx);
const latest = () => widgets.at(-1)?.lines.join("\n");
const exitListeners = process.listenerCount("exit");

// Only the UI clock is virtual; process shutdown's setTimeout stays real.
mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
try {
	extension({
		on(event, handler) { handlers.set(event, handler); },
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand() {},
		sendMessage() {},
	});
	assert.equal(process.listenerCount("exit"), exitListeners, "factory has no exit listener");
	await handlers.get("session_start")({}, ctx);
	await call("proc_start", { command: "echo ready; sleep 30", name: "widget-test" });
	await call("proc_wait", { id: "p1", pattern: "ready", timeout_ms: 5000 });
	mock.timers.tick(1000);
	assert.equal(widgets.length, 0, "no UI writes while disconnected");

	connected = true;
	mock.timers.tick(1000);
	assert.match(latest() ?? "", /widget-test · running · 2s/, "attach restores counter without a job event");

	connected = false;
	const count = widgets.length;
	mock.timers.tick(3000);
	assert.equal(widgets.length, count, "disconnect suppresses UI writes");
	connected = true;
	mock.timers.tick(1000);
	assert.match(latest(), /running · 6s/, "reconnect preserves original uptime");

	await call("proc_stop", { id: "p1" });
	assert.equal(latest(), "", "last job exit clears widget");
	const stoppedCount = widgets.length;
	mock.timers.tick(3000);
	assert.equal(widgets.length, stoppedCount, "last job exit stops ticker");
	console.log("PASS  widget attach/reconnect, uptime, and idle timer cleanup");
} finally {
	await handlers.get("session_shutdown")?.({}, ctx);
	mock.timers.reset();
}
assert.equal(process.listenerCount("exit"), exitListeners, "shutdown removes exit listener");
console.log("PASS  shutdown cleanup");
