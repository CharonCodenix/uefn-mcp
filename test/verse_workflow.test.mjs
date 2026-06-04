import test from "node:test";
import assert from "node:assert/strict";
import { frameMessage } from "../src/lib/verse_workflow.mjs";

test("frames Verse workflow protocol messages with Content-Length", () => {
  const message = {
    seq: 1,
    type: 1,
    command: "compileProject",
    params: {}
  };
  const framed = frameMessage(message);
  const [header, body] = framed.split("\r\n\r\n");
  const length = Number(header.match(/Content-Length:\s*(\d+)/)[1]);

  assert.equal(length, Buffer.byteLength(body, "utf8"));
  assert.deepEqual(JSON.parse(body), message);
});

