import { expect, it, vi } from "vitest";
import { readBoundedBody } from "../lib/c3/bounded-body";

it("BB-1 null body reports absent", async () => {
  expect(await readBoundedBody(null, 63)).toEqual({ kind: "absent" });
});
it("BB-2 more than limit bytes reports too_large and cancels the stream", async () => {
  const cancel = vi.fn(); let n = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(40).fill(++n)); }, cancel }, { highWaterMark: 0 });
  expect(await readBoundedBody(stream, 63)).toEqual({ kind: "too_large" });
  expect(cancel).toHaveBeenCalledOnce();
});
it("BB-3 exactly limit bytes across chunks returns exact bytes", async () => {
  const values = [new Uint8Array(20).fill(1), new Uint8Array(43).fill(2)];
  const stream = new ReadableStream<Uint8Array>({ pull(c) { const value = values.shift(); if (value) c.enqueue(value); else c.close(); } }, { highWaterMark: 0 });
  expect(await readBoundedBody(stream, 63)).toEqual({ kind: "bytes", bytes: new Uint8Array([...new Uint8Array(20).fill(1), ...new Uint8Array(43).fill(2)]) });
});
it("BB-4 stream error reports read_failed", async () => {
  expect(await readBoundedBody(new ReadableStream({ pull() { throw new Error("read sentinel"); } }, { highWaterMark: 0 }), 63)).toEqual({ kind: "read_failed" });
});
it("BB-5 non-Uint8Array chunk reports read_failed", async () => {
  for (const value of ["bad", 4]) {
    const stream = new ReadableStream<unknown>({ pull(c) { c.enqueue(value); c.close(); } }, { highWaterMark: 0 });
    expect(await readBoundedBody(stream as ReadableStream<Uint8Array>, 63)).toEqual({ kind: "read_failed" });
  }
});
it("BB-6 locked stream reports read_failed", async () => {
  const stream = new ReadableStream<Uint8Array>(); const lock = stream.getReader();
  try { expect(await readBoundedBody(stream, 63)).toEqual({ kind: "read_failed" }); } finally { lock.releaseLock(); }
});
it("BB-7 cancellation rejection reports read_failed", async () => {
  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(40)); }, cancel() { return Promise.reject(new Error("cancel sentinel")); } }, { highWaterMark: 0 });
  expect(await readBoundedBody(stream, 63)).toEqual({ kind: "read_failed" });
});
