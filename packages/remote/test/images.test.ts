import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog } from "../src/eventlog.ts";
import { attachmentContent, imageCachePath, messageContent, sendUserFileImages } from "../src/images.ts";
import { transcriptEvents } from "../src/desktop.ts";
import { summarize } from "../src/sessions.ts";
import { ATTACHMENT_CAP } from "../src/protocol.ts";
import { reduce, timelineItems } from "../web/timeline.ts";
import { fileSymlinks, needsPosixModes } from "../../../test/capabilities.ts";

const data = Buffer.from("synthetic image bytes").toString("base64");
const image = { type: "image", source: { type: "base64", media_type: "image/png", data } };

test("desktop image-only user, assistant and tool results become blob-backed image parts", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-image-test-"));
  const log = EventLog.open({ dir });
  t.after(() => { log.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const type of ["user", "assistant"]) {
    const result = transcriptEvents(JSON.stringify({ type, uuid: type, message: { content: [image] } }), dir, () => "", value => log.image(value));
    assert.equal(result.bodies.length, 1);
    const event = log.append(result.bodies[0]!);
    assert.ok(event.kind === "user" || event.kind === "assistant");
    assert.equal(event.text, "");
    assert.equal(event.images?.[0]?.type, "image");
    assert.equal(event.images?.[0]?.mediaType, "image/png");
    assert.equal(log.blob(event.images![0]!.blob!), data);
    assert.equal(timelineItems(reduce([event])).length, 1);
  }
  const result = transcriptEvents(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: [image] }] } }), dir, () => "", value => log.image(value));
  assert.equal(result.bodies[0]?.kind, "tool_result");
  assert.equal(log.blob(result.bodies[0]!.images![0]!.blob!), data);
  assert.deepEqual(messageContent([null, { type: "image", source: { type: "url", url: "https://invalid" } }]).images, [{ type: "image", mediaType: "image/png" }]);
});

test("cache paths reject outside roots, traversal and symlink escapes", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-image-home-"));
  const root = path.join(home, ".claude", "images");
  fs.mkdirSync(root, { recursive: true });
  const safe = path.join(root, "1.png"), outside = path.join(home, "outside.png");
  fs.writeFileSync(safe, "safe"); fs.writeFileSync(outside, "outside");
  if (fileSymlinks) fs.symlinkSync(outside, path.join(root, "escape.png"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(imageCachePath(safe, home), fs.realpathSync(safe));
  assert.equal(imageCachePath(outside, home), null);
  assert.equal(imageCachePath(path.join(root, "..", "..", "outside.png"), home), null);
  if (fileSymlinks) assert.equal(imageCachePath(path.join(root, "escape.png"), home), null);
  assert.equal(imageCachePath(path.join(root, "missing.png"), home), null);
  assert.equal(imageCachePath("relative.png", home), null);
  fs.rmSync(path.join(home, ".claude"), { recursive: true });
  fs.symlinkSync(home, path.join(home, ".claude"), "junction");
  assert.equal(imageCachePath(path.join(home, ".claude", "outside.png"), home), null);
});

test("referenced tmp image caches load, missing or unapproved references remain placeholders", t => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "claude-image-test-"));
  const images = path.join(cache, "session", "images");
  fs.mkdirSync(images, { recursive: true });
  const file = path.join(images, "01.png"); fs.writeFileSync(file, Buffer.from(data, "base64"));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const stored: string[] = [];
  const converted = messageContent(`Before [Image: source: ${file}] after`, value => { stored.push(value); return "blob-id"; });
  assert.equal(converted.text, "Before  after");
  assert.equal(converted.images[0]?.blob, "blob-id");
  assert.deepEqual(stored, [data]);
  const missing = messageContent(`[Image: source: ${images}/missing.png] [Image: source: /etc/passwd]`, () => { assert.fail("must not store an unsafe file"); });
  assert.equal(missing.images.length, 2);
  assert.ok(missing.images.every(part => !part.blob));
});

test("the attachment folder is created 0700, not 0755", { skip: needsPosixModes }, t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-attach-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  attachmentContent(cwd, "see attached", [{ blob: "b1", name: "note.txt", mediaType: "text/plain" }], () => Buffer.from("hello").toString("base64"));
  assert.equal(fs.statSync(path.join(cwd, ".ripple-attachments")).mode & 0o777, 0o700);
});

test("a SendUserFile image is read through the blob sink and relative paths resolve against cwd", t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-sendfile-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-sendfile-log-"));
  const log = EventLog.open({ dir });
  t.after(() => { log.close(); fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); });
  const bytes = Buffer.from("raster bytes");
  fs.mkdirSync(path.join(cwd, "out"));
  fs.writeFileSync(path.join(cwd, "out", "shot.png"), bytes);
  const line = JSON.stringify({ type: "assistant", uuid: "a1", message: { id: "m1", model: "x", content: [
    { type: "text", text: "Here it is." },
    { type: "tool_use", id: "f1", name: "SendUserFile", input: { files: ["out/shot.png"], caption: "the shot", status: "normal" } },
  ] } });
  const bodies = transcriptEvents(line, cwd, summarize, value => log.image(value)).bodies;
  const event = log.append(bodies[0]!);
  assert.equal(event.kind, "assistant");
  assert.equal(event.text, "Here it is.");
  assert.equal(event.images?.[0]?.type, "image");
  assert.equal(event.images?.[0]?.mediaType, "image/png");
  assert.ok(event.images?.[0]?.blob);
  assert.equal(log.blob(event.images![0]!.blob!), bytes.toString("base64"));
  assert.equal(event.tools?.[0]?.summary, "out/shot.png, the shot");
});

test("a SendUserFile non-image, missing or oversized file yields no image and never throws", t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-sendfile-bad-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "notes.txt"), "text, not an image");
  fs.writeFileSync(path.join(cwd, "big.png"), Buffer.alloc(ATTACHMENT_CAP + 1));
  fs.mkdirSync(path.join(cwd, "folder.png"));
  const stored: string[] = [];
  const sink = (value: string): string => { stored.push(value); return "blob"; };
  const content = [{ type: "tool_use", id: "f1", name: "SendUserFile", input: { files: ["notes.txt", "missing.png", "big.png", "folder.png", 7], status: "normal" } }];
  assert.deepEqual(sendUserFileImages(content, cwd, sink), []);
  assert.deepEqual(stored, []);
  const parsed = transcriptEvents(JSON.stringify({ type: "assistant", message: { content } }), cwd, summarize, sink);
  const event = parsed.bodies[0];
  assert.equal(event?.kind, "assistant");
  assert.deepEqual(event?.images, []);
  assert.match(String(event?.kind === "assistant" ? event.tools[0]?.summary : ""), /notes\.txt/);
});

test("a SendUserFile image outside the cwd is shown, as the tool's scratchpad files are", t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-sendfile-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-sendfile-out-"));
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(outside, "shot.png"), Buffer.from("png"));
  fs.mkdirSync(path.join(outside, "dir.png"));
  const stored: string[] = [];
  const content = [{ type: "tool_use", id: "f1", name: "SendUserFile", input: { files: [path.join(outside, "shot.png"), path.join(outside, "dir.png")], status: "normal" } }];
  assert.deepEqual(sendUserFileImages(content, cwd, value => { stored.push(value); return "blob"; }), [{ type: "image", mediaType: "image/png", blob: "blob" }]);
  assert.deepEqual(stored, [Buffer.from("png").toString("base64")]);
});

test("summarize names a SendUserFile's files and caption without a caption, and blank input is empty", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-sendfile-sum-"));
  try {
    assert.equal(summarize("SendUserFile", { files: ["a.png", path.join(cwd, "b.jpg")], caption: "before vs after" }, cwd), "a.png, b.jpg, before vs after");
    assert.equal(summarize("SendUserFile", { files: ["only.gif"], status: "proactive" }, cwd), "only.gif");
    assert.equal(summarize("SendUserFile", {}, cwd), "");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
