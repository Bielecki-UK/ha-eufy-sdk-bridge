// A local cover carries the start time of its recording, from the cover's file name, so "Last event" can
// show when the event happened rather than when the bridge found it. /event-image sends it as
// `x-recording-start` (camera local time, no offset), only with the exact bytes it was recorded for.
import { test, mock } from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createState } from "../src/state.mjs";
import { loadConfig } from "../src/config.mjs";
import { noteRecordingStart, recordingStartFor, recordingStartOf } from "../src/recording-start.mjs";
import { createWarmup } from "../src/warmup.mjs";

const COVER = Buffer.from("local-cover");
const PUSH = Buffer.from("push-thumbnail");
const T8200_CROP = "/mnt/userdata/video/h264_video_20261102_135346n.jpg";

test("the recording start is read from a T8200's and a HomeBase's cover names", () => {
  assert.equal(recordingStartOf(T8200_CROP), "2026-11-02T13:53:46");
  assert.equal(recordingStartOf("/media/mmcblk0p1/video/20261013100000_c01.jpg"), "2026-10-13T10:00:00");
});

test("a cover name without a valid time gives none", () => {
  assert.equal(recordingStartOf("/mnt/userdata/snapshort.jpg"), undefined);
  assert.equal(recordingStartOf("h264_video_20261332_250000n.jpg"), undefined);
  assert.equal(recordingStartOf(undefined), undefined);
});

test("the recorded start is answered only for the bytes it was recorded with", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recording-start-"));
  noteRecordingStart(dir, "CAM1", COVER, T8200_CROP);
  assert.equal(recordingStartFor(dir, "CAM1", COVER), "2026-11-02T13:53:46");
  assert.equal(recordingStartFor(dir, "CAM1", PUSH), undefined);
  assert.equal(recordingStartFor(dir, "CAM2", COVER), undefined);

  noteRecordingStart(dir, "CAM1", COVER, "/mnt/userdata/snapshort.jpg");
  assert.equal(recordingStartFor(dir, "CAM1", COVER), undefined, "a cover with no time clears the old one");
});

function setup(stored) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-image-start-"));
  const state = createState();
  state.flags.ready = true;
  const handler = createHttpHandler({
    ...loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" }),
    state,
    eventImageDir: dir,
    eventLog: () => {},
    autoHealEventImage: () => {},
    eufy: {
      getDevice: async () => ({
        camera: () => ({ snapshotStored: async () => (stored ? stored : Promise.reject(new Error("not-observed"))) }),
      }),
    },
  });
  const get = () =>
    new Promise((resolve) => {
      let headers = {};
      const res = {
        writeHead(_code, h) {
          headers = h ?? {};
        },
        setHeader() {},
        end(body) {
          resolve({ headers, body: Buffer.from(body ?? "") });
        },
      };
      handler({ url: "/event-image/CAM1", headers: { host: "x" }, method: "GET" }, res);
    });
  return { dir, file: path.join(dir, "last-event-CAM1.jpg"), get };
}

test("a cover served from disk carries its recording start", async () => {
  const t = setup(undefined);
  fs.writeFileSync(t.file, COVER);
  noteRecordingStart(t.dir, "CAM1", COVER, T8200_CROP);

  const { headers, body } = await t.get();
  assert.deepEqual(body, COVER);
  assert.equal(headers["x-recording-start"], "2026-11-02T13:53:46");
});

test("a cover newer than the retained push thumbnail carries its recording start", async () => {
  const t = setup(PUSH);
  assert.equal((await t.get()).headers["x-recording-start"], undefined, "a push thumbnail has none");
  await new Promise((r) => setTimeout(r, 30)); // the persist lands, and the cover's mtime is later
  fs.writeFileSync(t.file, COVER);
  noteRecordingStart(t.dir, "CAM1", COVER, T8200_CROP);

  const { headers, body } = await t.get();
  assert.deepEqual(body, COVER);
  assert.equal(headers["x-recording-start"], "2026-11-02T13:53:46");
});

test("a push thumbnail written over the cover does not inherit its recording start", async () => {
  const t = setup(undefined);
  fs.writeFileSync(t.file, COVER);
  noteRecordingStart(t.dir, "CAM1", COVER, T8200_CROP);
  fs.writeFileSync(t.file, PUSH);

  const { headers, body } = await t.get();
  assert.deepEqual(body, PUSH);
  assert.equal(headers["x-recording-start"], undefined);
});

/** A standalone camera answering latest-info with one crop, and its cover image. */
function fakeCamera(crop) {
  const s = new EventEmitter();
  s.isConnected = true;
  s.queryDatabase = (_table, opts) => {
    if (opts.innerCmd !== 10013) return;
    const reply = { data: [{ device_sn: "CAM1", payload: { event_count: 1, crop_hb3_path: crop } }], cmd: 10013 };
    setTimeout(() => s.emit("dbChunk", { text: JSON.stringify(reply) }), 0);
  };
  s.requestImage = (file) => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(file), Buffer.alloc(300, 0x41)]);
    setTimeout(() => s.emit("image", { file, data: jpeg }), 0);
  };
  return s;
}

async function refreshWith(model, crop) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recording-found-"));
  const sent = [];
  const warm = createWarmup({
    eventImageDir: dir,
    eventLog: () => {},
    broadcast: (m) => sent.push(m),
    state: { faceNames: new Map() },
    eufy: {
      getP2pSessions: () => new Map([["CAM1", fakeCamera(crop)]]),
      getDevices: async () => [{ sn: "CAM1", p2pDid: "EUPREMB-012345-ABCDE", raw: { device_model: model } }],
    },
  });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let done = false;
    const p = warm.refreshLastEventImageFor("CAM1").finally(() => (done = true));
    while (!done) {
      mock.timers.tick(200);
      await new Promise((r) => setImmediate(r));
    }
    await p;
  } finally {
    mock.timers.reset();
  }
  return sent.filter((m) => m.event === "recordingFound");
}

test("a new recording by a detection-only model is announced with its start", async () => {
  assert.deepEqual(await refreshWith("T8200", T8200_CROP), [
    { event: "recordingFound", deviceSn: "CAM1", recordingStart: "2026-11-02T13:53:46" },
  ]);
});

test("a new recording by a model not known to record only on detection is not announced", async () => {
  assert.deepEqual(await refreshWith("T8410", T8200_CROP), []);
});

test("a cover whose name carries no time is not announced", async () => {
  assert.deepEqual(await refreshWith("T8200", "/mnt/userdata/snapshort.jpg"), []);
});
