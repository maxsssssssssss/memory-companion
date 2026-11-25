// A local deadline for the two independent person-material reads. It never
// retries a request or turns a timeout into a confirmed empty response.
export const PERSON_MATERIAL_READ_TIMEOUT_MS = 12_000;

export async function readPersonMaterialWithDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, milliseconds: number
): Promise<T> {
  let dispose = () => {};
  let bounded: AbortSignal;
  if (typeof AbortSignal.timeout === "function" && typeof AbortSignal.any === "function") {
    bounded = AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]);
  } else {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("Reading timed out", "TimeoutError")), milliseconds);
    bounded = controller.signal;
    dispose = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
  }
  // Also fence adapters that resolve after cancellation, rather than relying on
  // every fetch substitute to honor AbortSignal correctly.
  let stop: () => void = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      const aborted = () => reject(bounded.reason ?? new DOMException("Reading aborted", "AbortError"));
      stop = () => bounded.removeEventListener("abort", aborted);
      if (bounded.aborted) { aborted(); return; }
      bounded.addEventListener("abort", aborted, { once: true });
      Promise.resolve().then(() => read(bounded)).then(
        value => bounded.aborted ? aborted() : resolve(value), reject
      );
    });
  } finally { stop(); dispose(); }
}
