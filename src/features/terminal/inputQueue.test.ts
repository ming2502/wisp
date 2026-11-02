import { describe, expect, it } from "vitest";
import { createInputQueue } from "./inputQueue";

function bytes(text: string) {
  return new TextEncoder().encode(text);
}

function deferredSender() {
  const sent: string[] = [];
  const waiting: (() => void)[] = [];
  const send = (data: Uint8Array) => {
    sent.push(new TextDecoder().decode(data));
    return new Promise<void>((resolve) => waiting.push(resolve));
  };
  const finishOne = async () => {
    waiting.shift()!();
    await new Promise((resolve) => setTimeout(resolve));
  };
  return { sent, send, finishOne };
}

describe("createInputQueue", () => {
  it("keeps one write in flight and merges what arrives meanwhile, in order", async () => {
    const { sent, send, finishOne } = deferredSender();
    const push = createInputQueue(send);
    push(bytes("a"));
    push(bytes("b"));
    push(bytes("c"));
    expect(sent).toEqual(["a"]);
    await finishOne();
    expect(sent).toEqual(["a", "bc"]);
    await finishOne();
    push(bytes("d"));
    expect(sent).toEqual(["a", "bc", "d"]);
  });

  it("handles a paste larger than the engine's argument limit", async () => {
    const received: number[] = [];
    const push = createInputQueue(async (data) => {
      received.push(data.length);
    });
    push(new Uint8Array(5_000_000));
    await new Promise((resolve) => setTimeout(resolve));
    expect(received).toEqual([5_000_000]);
  });

  it("recovers after a failed write", async () => {
    const sent: string[] = [];
    let fail = true;
    const push = createInputQueue(async (data) => {
      sent.push(new TextDecoder().decode(data));
      if (fail) {
        fail = false;
        throw new Error("closed");
      }
    });
    // Vitest fails the run on an unhandled rejection, so reaching the end proves there was none.
    push(bytes("a"));
    await new Promise((resolve) => setTimeout(resolve));
    push(bytes("b"));
    await new Promise((resolve) => setTimeout(resolve));
    expect(sent).toEqual(["a", "b"]);
  });
});
