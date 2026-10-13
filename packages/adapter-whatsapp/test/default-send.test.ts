import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { test } from "node:test";
import {
  WHATSAPP_AUTH_DIR_NAME,
  createWhatsAppAdapter,
  createWhatsAppSend,
  defaultWhatsAppSend,
  parseSendOnlyConfig,
  whatsAppAuthDir,
} from "../dist/index.js";

const SECRET = "sess_live_do_not_log";
const ROUTE = {
  profileId: "profile-a",
  adapterId: "whatsapp",
  accountId: "wa-1",
  chatId: "1001@s.whatsapp.net",
};
// Never created: the fake socket touches no filesystem, no network, and no real WhatsApp session.
const PROFILE_DIR = join(tmpdir(), "pi-hermes-gateway-wa-fake-profile");
const REQUEST = { jid: ROUTE.chatId, text: "hi", timeoutMs: 50 };

type FakeCall = { jid: string; content: unknown };
type FakeOptions = { message?: unknown; hang?: boolean; throwOnSend?: Error; throwOnOpen?: (authDir: string) => Error };

function fakeSocket(options: FakeOptions = {}) {
  const state = { openedWith: [] as string[], calls: [] as FakeCall[], closed: 0 };
  const socketFactory = async ({ authDir }: { authDir: string }) => {
    state.openedWith.push(authDir);
    if (options.throwOnOpen) throw options.throwOnOpen(authDir);
    return {
      sendMessage(jid: string, content: unknown): unknown {
        state.calls.push({ jid, content });
        if (options.throwOnSend) throw options.throwOnSend;
        if (options.hang) return new Promise(() => undefined);
        return Promise.resolve(options.message);
      },
      close() {
        state.closed += 1;
      },
    };
  };
  return { socketFactory, state };
}

test("auth dir is a fixed child of the gateway profile dir and never a config value", () => {
  const authDir = whatsAppAuthDir(PROFILE_DIR);
  assert.equal(WHATSAPP_AUTH_DIR_NAME, "whatsapp-auth");
  assert.equal(authDir, resolve(PROFILE_DIR, WHATSAPP_AUTH_DIR_NAME));
  assert.equal(authDir.startsWith(resolve(PROFILE_DIR) + sep), true);
  assert.equal(isAbsolute(whatsAppAuthDir("relative-profile")), true);
  assert.throws(() => whatsAppAuthDir(""), /profileDir/);
  assert.throws(() => whatsAppAuthDir("   "), /profileDir/);

  const foreignSession = join(tmpdir(), "someone-elses-wa-session");
  assert.throws(() => parseSendOnlyConfig({ kind: "send-only", authDir: foreignSession }), /invalid/);
  try {
    parseSendOnlyConfig({ kind: "send-only", authDir: foreignSession });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.equal(message.includes(foreignSession), false);
  }
});

test("defaultWhatsAppSend without socket deps is unconfigured, opens nothing, sends nothing", () => {
  const result = defaultWhatsAppSend(REQUEST);
  assert.deepEqual(result, { kind: "unconfigured" });
  assert.equal(typeof (result as { then?: unknown }).then, "undefined");

  const adapter = createWhatsAppAdapter({ kind: "send-only" }, { send: defaultWhatsAppSend });
  const receipt = adapter.send({ deliveryId: "dlv-unconf", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.reason, "whatsapp-socket-unconfigured");
  assert.equal(receipt.providerMessageId, undefined);
});

test("fake socket send opens under the profile auth dir, sends the text, closes, and is accepted", async () => {
  const { socketFactory, state } = fakeSocket({ message: { key: { remoteJid: ROUTE.chatId, id: "wamid.fake-1" } } });
  const result = await defaultWhatsAppSend(REQUEST, { socketFactory, profileDir: PROFILE_DIR });
  assert.deepEqual(result, { kind: "ok", providerMessageId: "wamid.fake-1" });
  assert.deepEqual(state.openedWith, [whatsAppAuthDir(PROFILE_DIR)]);
  assert.deepEqual(state.calls, [{ jid: ROUTE.chatId, content: { text: "hi" } }]);
  assert.equal(state.closed, 1);

  const bound = fakeSocket({ message: { key: { id: "wamid.fake-2" } } });
  const adapter = createWhatsAppAdapter(
    { kind: "send-only", timeoutMs: 50 },
    { send: createWhatsAppSend({ socketFactory: bound.socketFactory, profileDir: PROFILE_DIR }) },
  );
  const receipt = await adapter.send({ deliveryId: "dlv-bound", route: ROUTE, text: "hello" });
  assert.equal(receipt.receiptLevel, "accepted");
  assert.equal(receipt.providerMessageId, "wamid.fake-2");
  assert.deepEqual(bound.state.calls, [{ jid: ROUTE.chatId, content: { text: "hello" } }]);
});

test("socket without a close method still sends and is accepted", async () => {
  const send = createWhatsAppSend({
    socketFactory: () => ({ sendMessage: () => ({ key: { id: "wamid.noclose" } }) }),
    profileDir: PROFILE_DIR,
  });
  assert.deepEqual(await send(REQUEST), { kind: "ok", providerMessageId: "wamid.noclose" });
});

test("missing or blank provider message id is ok-without-id and commit-unknown via the adapter", async () => {
  for (const message of [undefined, null, {}, { key: {} }, { key: { id: "   " } }, { key: { id: 42 } }]) {
    const { socketFactory, state } = fakeSocket({ message });
    const result = await defaultWhatsAppSend(REQUEST, { socketFactory, profileDir: PROFILE_DIR });
    assert.deepEqual(result, { kind: "ok" });
    assert.equal(state.closed, 1);
  }
  const { socketFactory } = fakeSocket({ message: { key: {} } });
  const adapter = createWhatsAppAdapter(
    { kind: "send-only" },
    { send: (req) => defaultWhatsAppSend(req, { socketFactory, profileDir: PROFILE_DIR }) },
  );
  const receipt = await adapter.send({ deliveryId: "dlv-noid", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.reason, "whatsapp-send-unconfirmed");
  assert.equal(receipt.providerMessageId, undefined);
});

test("hung socket send is timeout, the socket is closed, and there is no retry", async () => {
  const { socketFactory, state } = fakeSocket({ hang: true });
  const result = await defaultWhatsAppSend({ ...REQUEST, timeoutMs: 5 }, { socketFactory, profileDir: PROFILE_DIR });
  assert.deepEqual(result, { kind: "timeout" });
  assert.equal(state.calls.length, 1);
  assert.equal(state.closed, 1);

  const adapter = createWhatsAppAdapter(
    { kind: "send-only", timeoutMs: 5 },
    { send: createWhatsAppSend({ socketFactory, profileDir: PROFILE_DIR }) },
  );
  const receipt = await adapter.send({ deliveryId: "dlv-hang", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.reason, "timeout");
  assert.equal(state.calls.length, 2);
  assert.equal(state.closed, 2);
});

test("a socket that opens after the timeout is closed and never sends", async () => {
  let release: ((socket: unknown) => void) | undefined;
  const socketFactory = () =>
    new Promise<{ sendMessage(): unknown; close(): void }>((settle) => {
      release = settle as (socket: unknown) => void;
    });
  const send = createWhatsAppSend({ socketFactory, profileDir: PROFILE_DIR });
  const result = await send({ ...REQUEST, timeoutMs: 5 });
  assert.deepEqual(result, { kind: "timeout" });

  let sent = 0;
  let closed = 0;
  assert.equal(typeof release, "function");
  release?.({
    sendMessage() {
      sent += 1;
      return { key: { id: "late" } };
    },
    close() {
      closed += 1;
    },
  });
  await new Promise((tick) => setTimeout(tick, 0));
  assert.equal(sent, 0);
  assert.equal(closed, 1);
});

test("socket open errors redact the auth dir path and the session secret and stay commit-unknown", async () => {
  const authDir = whatsAppAuthDir(PROFILE_DIR);
  const { socketFactory, state } = fakeSocket({
    throwOnOpen: (dir) => new Error(`ENOENT ${dir}/creds.json while using ${SECRET}`),
  });
  await assert.rejects(
    Promise.resolve(defaultWhatsAppSend(REQUEST, { socketFactory, profileDir: PROFILE_DIR })),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.equal(message.includes(authDir), false);
      assert.equal(message.includes("<auth-dir>/creds.json"), true);
      return true;
    },
  );
  assert.equal(state.calls.length, 0);

  const adapter = createWhatsAppAdapter(
    { kind: "send-only", sessionSecret: SECRET },
    { send: (req) => defaultWhatsAppSend(req, { socketFactory, profileDir: PROFILE_DIR }) },
  );
  const receipt = await adapter.send({ deliveryId: "dlv-open-err", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.providerMessageId, undefined);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(authDir), false);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(receipt.reason?.includes("<auth-dir>"), true);
  assert.equal(receipt.reason?.includes("<redacted>"), true);
});

test("sendMessage errors are commit-unknown and the socket is still closed", async () => {
  const { socketFactory, state } = fakeSocket({ throwOnSend: new Error("socket closed by peer") });
  const adapter = createWhatsAppAdapter(
    { kind: "send-only" },
    { send: createWhatsAppSend({ socketFactory, profileDir: PROFILE_DIR }) },
  );
  const receipt = await adapter.send({ deliveryId: "dlv-send-err", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.reason, "socket closed by peer");
  assert.equal(state.calls.length, 1);
  assert.equal(state.closed, 1);
});

test("createWhatsAppSend rejects missing socket factory or profile dir before any send", async () => {
  const { socketFactory, state } = fakeSocket({ message: { key: { id: "never" } } });
  assert.throws(() => createWhatsAppSend({ profileDir: PROFILE_DIR } as never), /socketFactory/);
  assert.throws(() => createWhatsAppSend({ socketFactory, profileDir: "" }), /profileDir/);
  assert.throws(() => createWhatsAppSend(undefined as never), /socketFactory/);

  const adapter = createWhatsAppAdapter(
    { kind: "send-only" },
    { send: (req) => defaultWhatsAppSend(req, { socketFactory, profileDir: "" }) },
  );
  const receipt = await adapter.send({ deliveryId: "dlv-bad-deps", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.match(receipt.reason ?? "", /profileDir/);
  assert.equal(state.openedWith.length, 0);
  assert.equal(state.calls.length, 0);
});
