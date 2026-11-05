// iPhone Safari can't loop over a ReadableStream with `for await`, which pdf.js relies on.
// Add that ability when it's missing (used by both the page and the PDF worker).
if (typeof ReadableStream !== 'undefined' && !ReadableStream.prototype[Symbol.asyncIterator]) {
  const values = async function* ({ preventCancel = false } = {}) {
    const reader = this.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      if (!preventCancel) reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, { value: values, writable: true, configurable: true });
  if (!ReadableStream.prototype.values) Object.defineProperty(ReadableStream.prototype, 'values', { value: values, writable: true, configurable: true });
}
