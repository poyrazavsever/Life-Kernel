// Integration tests start servers and write files, and CI machines (Windows ones especially) sometimes stall
// for seconds. The default 5-second limit failed correct tests there; these normally take well under a second.
export default { test: { testTimeout: 30_000, hookTimeout: 30_000 } };
