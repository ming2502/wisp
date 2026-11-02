/**
 * IPC calls are not guaranteed to arrive in the order they were made, so only one write is in
 * flight at a time and keystrokes typed meanwhile are sent together afterwards.
 */
export function createInputQueue(send: (data: Uint8Array) => Promise<void>) {
  let pending: Uint8Array[] = [];
  let sending = false;

  function takePending() {
    const data = new Uint8Array(pending.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of pending) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    pending = [];
    return data;
  }

  async function drain() {
    if (sending) return;
    sending = true;
    while (pending.length > 0) {
      try {
        await send(takePending());
      } catch {
        // The terminal is gone, and its end is reported separately.
      }
    }
    sending = false;
  }

  return (data: Uint8Array) => {
    pending.push(data);
    void drain();
  };
}
