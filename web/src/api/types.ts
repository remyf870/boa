/**
 * API response types (Phase 0).
 *
 * ASSUMPTION (TODO(server)): GET /api/me returns the signed-in user directly
 * as JSON with at least the fields below. `roles` tolerates either plain role
 * names or per-cost-centre assignment objects (§3: roles are assigned per
 * cost centre), so the shell keeps working whichever shape the server settles
 * on.
 */

export type RoleLike = string | { role: string; costCentre?: string | null };

export interface Me {
  id: string;
  email: string;
  displayName: string;
  roles: RoleLike[];
  bannerAcknowledged: boolean;
}

/** Distinct role names for the top-bar summary. */
export function roleNames(roles: RoleLike[] | null | undefined): string[] {
  if (!roles) {
    return [];
  }
  const names = roles.map((entry) => (typeof entry === "string" ? entry : entry.role));
  return [...new Set(names)];
}
