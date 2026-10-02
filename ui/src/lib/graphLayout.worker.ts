// The graph view's force layout off the main thread (see `graphLayout.ts`).

import { createLayoutWorker, type LayoutIn } from "./graphLayout";

const scope = self as unknown as { postMessage(m: unknown, transfer: Transferable[]): void; onmessage: ((e: MessageEvent<LayoutIn>) => void) | null };
const handle = createLayoutWorker(
  (m, transfer) => scope.postMessage(m, transfer ?? []),
  (f) => setTimeout(f, 0),
);
scope.onmessage = (e) => handle(e.data);
