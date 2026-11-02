// CI must never send Discord messages or make paid HTTP calls. Tests exercising
// HTTP adapters pass explicit offline clients instead of ambient fetch.
Object.defineProperty(globalThis, "fetch", {
  value: () => Promise.reject(new Error("Ambient HTTP is disabled in tests.")),
  writable: false,
  configurable: false,
});
