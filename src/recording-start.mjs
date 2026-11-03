// The start time of the recording a local cover belongs to, kept beside last-event-<sn>.jpg so
// /event-image can say when the picture's event happened, not when the bridge found it.
//
// A station names each cover after its recording: `h264_video_20261102_135346n.jpg` on a standalone
// T8200, `20261013100000_c01.jpg` on a HomeBase. The time is the camera's own wall clock (a T8200 named
// a recording `…_020046n.jpg` at 01:30:58 UTC in British Summer Time), and no device reports its zone,
// so it is passed on as local time with no offset for the consumer to place in its own zone.
//
// The record carries a hash of the image it describes, and is answered only for those exact bytes: a
// push thumbnail written over the cover later has no recording time, and must not inherit this one.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const NAME_TIME = /(\d{4})(\d{2})(\d{2})_?(\d{2})(\d{2})(\d{2})/;

/** `YYYY-MM-DDTHH:MM:SS` (camera local time) from a cover's path, or undefined when it names none. */
export function recordingStartOf(coverPath) {
  const m = NAME_TIME.exec(path.basename(String(coverPath ?? "")));
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const valid =
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi &&
    t.getUTCSeconds() === s;
  return valid ? t.toISOString().slice(0, 19) : undefined;
}

const sha1 = (data) => createHash("sha1").update(data).digest("hex");
const recordFile = (dir, sn) => path.join(dir, `last-event-${sn}.recording.json`);

/** Record the recording start of the cover `data` just persisted for `sn`; clear it when there is none. */
export function noteRecordingStart(dir, sn, data, coverPath) {
  const recordingStart = recordingStartOf(coverPath);
  try {
    if (recordingStart) fs.writeFileSync(recordFile(dir, sn), JSON.stringify({ sha1: sha1(data), recordingStart }));
    else fs.rmSync(recordFile(dir, sn), { force: true });
  } catch {
    /* best-effort: without it /event-image simply carries no recording time */
  }
}

/** The recording start recorded for exactly these bytes of `sn`'s cover, or undefined. */
export function recordingStartFor(dir, sn, data) {
  try {
    const rec = JSON.parse(fs.readFileSync(recordFile(dir, sn), "utf8"));
    return rec?.sha1 === sha1(data) && typeof rec.recordingStart === "string" ? rec.recordingStart : undefined;
  } catch {
    return undefined;
  }
}

// Models whose recordings are made only on a detection, so that a new recording means one. A camera that
// can record continuously would make a "new recording" mean nothing, and no device reports whether it
// does (a T8200 reports no recording-mode parameter at all), so a model joins only once measured. T8200:
// its recordings are irregular, and each pushed detection came 4–12 s after a recording started.
const DETECTION_ONLY_RECORDING_MODELS = new Set(["T8200"]);

/** Whether a new recording by this model means a detection. */
export function recordsOnlyOnDetection(model) {
  return DETECTION_ONLY_RECORDING_MODELS.has(model);
}
