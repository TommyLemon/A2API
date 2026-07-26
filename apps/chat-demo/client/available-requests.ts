/**
 * Available API catalog from admin (Access + Request + Document).
 */

export type AvailableRequest = {
  operation: string;
  tag: string;
  version: number;
  structure?: Record<string, unknown>;
  detail?: string;
  accessAlias?: string;
  accessName?: string;
  roles: string[];
  document?: {
    id: string | number;
    name?: string;
    method?: string;
    type?: string;
    url?: string;
    request?: string;
    operation?: string;
  };
  open?: boolean;
};

let items: AvailableRequest[] = [];
let loaded = false;
let loading: Promise<void> | null = null;

export function clearAvailableRequests(): void {
  items = [];
  loaded = false;
  loading = null;
}

export function listAvailableRequests(): AvailableRequest[] {
  return items.slice();
}

export async function ensureAvailableRequests(): Promise<AvailableRequest[]> {
  if (loaded) return items;
  if (loading) {
    await loading;
    return items;
  }
  loading = (async () => {
    const res = await fetch("/api/available-requests");
    const data = (await res.json().catch(() => null)) as {
      items?: AvailableRequest[];
      error?: string;
    } | null;
    if (!res.ok) {
      throw new Error(data?.error || `available-requests failed (${res.status})`);
    }
    items = Array.isArray(data?.items) ? data!.items! : [];
    loaded = true;
  })()
    .catch(() => {
      loaded = false;
      items = [];
    })
    .finally(() => {
      loading = null;
    });
  await loading;
  return items;
}

export async function reloadAvailableRequests(): Promise<AvailableRequest[]> {
  clearAvailableRequests();
  return ensureAvailableRequests();
}

/** Label for Data tab picker. */
export function availableRequestLabel(r: AvailableRequest): string {
  const roles = r.roles?.length ? ` [${r.roles.join(",")}]` : "";
  const open = r.open ? " · open" : "";
  return `${r.operation.toUpperCase()} ${r.tag} v${r.version}${open}${roles}`;
}

export type WriteGateDecision = "call" | "apply" | "try";

export type WriteGate = {
  operation: string;
  tag: string;
  decision: WriteGateDecision;
  roles: string[];
  document?: AvailableRequest["document"] | null;
  reason?: string;
  error?: string;
};

/** Document + Access gate for put/delete (via admin). */
export async function fetchWriteGate(
  operation: string,
  tag: string,
): Promise<WriteGate> {
  const qs = new URLSearchParams({
    operation: operation.toLowerCase(),
    tag,
  });
  try {
    const res = await fetch(`/api/write-gate?${qs}`);
    const data = (await res.json().catch(() => null)) as WriteGate | null;
    if (!res.ok || !data) {
      return {
        operation,
        tag,
        decision: "try",
        roles: [],
        reason: data?.error || "write-gate unavailable — try call",
      };
    }
    return data;
  } catch {
    return {
      operation,
      tag,
      decision: "try",
      roles: [],
      reason: "write-gate unreachable — try call",
    };
  }
}
