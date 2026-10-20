import { test } from "node:test";
import assert from "node:assert/strict";

import { createDeviceView } from "../src/device-view.mjs";

/** A minimal device the view can describe. */
function fakeDevice(sn) {
  return {
    describe: () => ({
      sn,
      name: sn,
      model: "T817L",
      modelName: "eufyCam",
      codec: "camera",
      capabilities: ["camera", "video", "battery"],
    }),
    getProperties: () => ({ battery: { value: 60 } }),
  };
}

/** Build the device view over a fake SDK that answers the liveness accessors. */
function view(liveness) {
  const eufy = {
    async getDevice(sn) {
      return fakeDevice(sn);
    },
    ...liveness,
  };
  return createDeviceView({ eufy, state: { streaming: new Set() } });
}

test("device view surfaces lastSeenMs and the explicit availability observation", async () => {
  const lastSeenMs = 1_700_000_000_000;
  const { describeDevice } = view({
    deviceState: () => ({ sn: "CAM1", stationSn: "CAM1", lastSeenMs }),
    deviceAvailability: () => ({ availability: "available" }),
  });
  const rec = await describeDevice("CAM1");
  assert.equal(rec.lastSeenMs, lastSeenMs);
  assert.equal(rec.availability, "available");
});

test("device view omits the liveness facts the SDK has nothing to report", async () => {
  // deviceState returns no lastSeenMs; deviceAvailability has no observation.
  const { describeDevice } = view({
    deviceState: () => ({ sn: "CAM1", stationSn: "CAM1" }),
    deviceAvailability: () => undefined,
  });
  const rec = await describeDevice("CAM1");
  assert.ok(!("lastSeenMs" in rec));
  assert.ok(!("availability" in rec));
});

test("device view works against an SDK that lacks the liveness accessors", async () => {
  const { describeDevice } = view({}); // no deviceState / deviceAvailability
  const rec = await describeDevice("CAM1");
  assert.ok(!("lastSeenMs" in rec));
  assert.ok(!("availability" in rec));
  assert.equal(rec.sn, "CAM1"); // the rest of the record is unaffected
});
