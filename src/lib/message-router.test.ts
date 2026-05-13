import { expect } from "chai";
import type { BeszelClient } from "./beszel-client";
import { dispatchMessage, type MessageRouterDeps } from "./message-router";

interface SentMessage {
    from: string;
    command: string;
    response: unknown;
    callback: ioBroker.MessageCallbackInfo | undefined;
}

interface TestHarness {
    sends: SentMessage[];
    logs: { level: "debug" | "warn"; msg: string }[];
    createdClients: { url: string; username: string; password: string }[];
    /** v0.4.5: clients registered via `onTestClientCreated`. */
    registered: BeszelClient[];
    /** v0.4.5: clients de-registered via `onTestClientDone`. */
    completed: BeszelClient[];
    deps: MessageRouterDeps;
}

/** Build a fresh test-harness with stub log/sendTo/createTestClient. */
function makeHarness(checkConnectionResult?: { success: boolean; message: string }): TestHarness {
    const sends: SentMessage[] = [];
    const logs: { level: "debug" | "warn"; msg: string }[] = [];
    const createdClients: { url: string; username: string; password: string }[] = [];
    const registered: BeszelClient[] = [];
    const completed: BeszelClient[] = [];

    const deps: MessageRouterDeps = {
        log: {
            debug: msg => logs.push({ level: "debug", msg }),
            warn: msg => logs.push({ level: "warn", msg }),
        },
        sendTo: (from, command, response, callback) => {
            sends.push({ from, command, response, callback });
        },
        createTestClient: (url, username, password) => {
            createdClients.push({ url, username, password });
            return {
                checkConnection: async () =>
                    checkConnectionResult ?? { success: true, message: "Connected successfully" },
            } as unknown as BeszelClient;
        },
        onTestClientCreated: client => registered.push(client),
        onTestClientDone: client => completed.push(client),
    };

    return { sends, logs, createdClients, registered, completed, deps };
}

function buildMessage(overrides: Partial<ioBroker.Message>): ioBroker.Message {
    return {
        command: "checkConnection",
        from: "system.adapter.test.0",
        callback: { id: 1, message: "x", time: 0, ack: false } as ioBroker.MessageCallbackInfo,
        message: undefined,
        ...overrides,
    } as ioBroker.Message;
}

describe("dispatchMessage", () => {
    describe("default-branch contract (H4 v0.4.4 regression)", () => {
        it("sendTo({ error: 'Unknown command' }) for an unrecognised command", async () => {
            const h = makeHarness();
            await dispatchMessage(buildMessage({ command: "totallyMadeUpCommand" }), h.deps);

            expect(h.sends).to.have.lengthOf(1);
            expect(h.sends[0].command).to.equal("totallyMadeUpCommand");
            expect(h.sends[0].response).to.deep.equal({ error: "Unknown command" });
            expect(h.sends[0].callback).to.not.equal(undefined);
        });

        it("emits a debug-line tagged with the unknown command name", async () => {
            const h = makeHarness();
            await dispatchMessage(buildMessage({ command: "weirdCmd" }), h.deps);

            const debugMsgs = h.logs.filter(l => l.level === "debug").map(l => l.msg);
            expect(debugMsgs.some(m => m.includes("unknown command 'weirdCmd'"))).to.equal(true);
        });

        it("never leaves callback ungerufen — sendTo is always invoked exactly once", async () => {
            const h = makeHarness();
            await dispatchMessage(buildMessage({ command: "x" }), h.deps);
            await dispatchMessage(buildMessage({ command: "y" }), h.deps);
            await dispatchMessage(buildMessage({ command: "z" }), h.deps);

            expect(h.sends).to.have.lengthOf(3);
            for (const s of h.sends) {
                expect(s.callback).to.not.equal(undefined);
            }
        });
    });

    describe("entry log", () => {
        it("emits H1 entry-debug BEFORE the callback early-return — broadcast still visible", async () => {
            const h = makeHarness();
            await dispatchMessage({ command: "broadcast", from: "x", message: {} } as ioBroker.Message, h.deps);

            // No sendTo because no callback, but the entry-debug must have fired.
            expect(h.sends).to.have.lengthOf(0);
            const debugMsgs = h.logs.filter(l => l.level === "debug").map(l => l.msg);
            expect(debugMsgs.some(m => m.includes("onMessage: command='broadcast'"))).to.equal(true);
            expect(debugMsgs.some(m => m.includes("has-callback=false"))).to.equal(true);
        });
    });

    describe("checkConnection", () => {
        it("missing url/username/password → sendTo with error message", async () => {
            const h = makeHarness();
            await dispatchMessage(
                buildMessage({ command: "checkConnection", message: { url: "", username: "u", password: "p" } }),
                h.deps,
            );

            expect(h.sends).to.have.lengthOf(1);
            expect(h.sends[0].response).to.deep.equal({
                success: false,
                message: "URL, username and password are required",
            });
            expect(h.createdClients).to.have.lengthOf(0);
        });

        it("complete config → creates testClient with creds and forwards the result", async () => {
            const h = makeHarness({ success: true, message: "Connected successfully" });
            await dispatchMessage(
                buildMessage({
                    command: "checkConnection",
                    message: { url: "http://h", username: "u", password: "p" },
                }),
                h.deps,
            );

            expect(h.createdClients).to.deep.equal([{ url: "http://h", username: "u", password: "p" }]);
            expect(h.sends).to.have.lengthOf(1);
            expect(h.sends[0].response).to.deep.equal({ success: true, message: "Connected successfully" });
        });
    });

    describe("test-client lifecycle hooks (v0.4.5 cancelAll-Latency)", () => {
        it("calls onTestClientCreated then onTestClientDone — adapter can track + abort at onUnload", async () => {
            const h = makeHarness({ success: true, message: "ok" });
            await dispatchMessage(
                buildMessage({
                    command: "checkConnection",
                    message: { url: "http://h", username: "u", password: "p" },
                }),
                h.deps,
            );

            expect(h.registered).to.have.lengthOf(1);
            expect(h.completed).to.have.lengthOf(1);
            // The same client instance must travel through both hooks so the
            // adapter's Set add/delete matches up.
            expect(h.registered[0]).to.equal(h.completed[0]);
        });

        it("onTestClientDone fires even when checkConnection throws — Set never leaks", async () => {
            const sends: SentMessage[] = [];
            const registered: BeszelClient[] = [];
            const completed: BeszelClient[] = [];
            const failingClient = {
                checkConnection: async () => {
                    throw new Error("boom");
                },
            } as unknown as BeszelClient;
            const deps: MessageRouterDeps = {
                log: { debug: () => {}, warn: () => {} },
                sendTo: (from, command, response, callback) => {
                    sends.push({ from, command, response, callback });
                },
                createTestClient: () => failingClient,
                onTestClientCreated: c => registered.push(c),
                onTestClientDone: c => completed.push(c),
            };
            await dispatchMessage(
                buildMessage({
                    command: "checkConnection",
                    message: { url: "http://h", username: "u", password: "p" },
                }),
                deps,
            );

            // The throw is caught by the outer try/catch — but the finally
            // around the testClient must still call onTestClientDone so the
            // adapter's Set stays clean.
            expect(registered).to.have.lengthOf(1);
            expect(completed).to.have.lengthOf(1);
            expect(registered[0]).to.equal(completed[0]);
            // Outer catch sends the failure response.
            expect(sends).to.have.lengthOf(1);
            expect((sends[0].response as { success: boolean }).success).to.equal(false);
        });

        it("missing-config path does NOT register a test-client (none was created)", async () => {
            const h = makeHarness();
            await dispatchMessage(
                buildMessage({
                    command: "checkConnection",
                    message: { url: "", username: "u", password: "p" },
                }),
                h.deps,
            );

            expect(h.registered).to.have.lengthOf(0);
            expect(h.completed).to.have.lengthOf(0);
        });
    });
});
