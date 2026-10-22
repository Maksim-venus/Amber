import { enterRunRoot, removeRunRoot } from "./temp-root.ts";

/** Gathers the run's temporary directories under one root and removes it afterwards. */
export default function setup(): () => void {
  const root = enterRunRoot();
  return () => removeRunRoot(root);
}
