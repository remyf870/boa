import { describe, expect, it } from 'vitest';
import { canAccessCostCentre, hasAnyRole, hasRole, hasRoleAnywhere } from '../src/plugins/rbac.js';
import type { CurrentUser } from '../src/auth/sessions.js';

const CC_A = '11111111-1111-1111-1111-111111111111';
const CC_B = '22222222-2222-2222-2222-222222222222';

function user(roles: { role: string; costCentreId: string | null }[]): CurrentUser {
  return {
    id: 'u',
    email: 'u@example.test',
    displayName: 'U',
    jobTitle: null,
    status: 'active',
    bannerAcknowledged: true,
    roles,
    sessionId: 's',
    csrfToken: 'c',
    via: 'dev',
  };
}

describe('RBAC scope logic (A.5.15 default-deny, per-cost-centre)', () => {
  it('denies everything to a user with no roles', () => {
    const u = user([]);
    expect(hasRole(u, 'requester')).toBe(false);
    expect(canAccessCostCentre(u, CC_A)).toBe(false);
  });

  it('scopes cost-centre roles to their cost centre only', () => {
    const u = user([{ role: 'requester', costCentreId: CC_A }]);
    expect(hasRole(u, 'requester', CC_A)).toBe(true);
    expect(hasRole(u, 'requester', CC_B)).toBe(false);
  });

  it("§3: a requester sees own history, NOT their whole cost centre's records", () => {
    const u = user([{ role: 'requester', costCentreId: CC_A }]);
    expect(canAccessCostCentre(u, CC_A)).toBe(false);
    expect(canAccessCostCentre(u, CC_B)).toBe(false);
  });

  it('approvers read their cost centre; accounting and auditor read org-wide (§3)', () => {
    const approver = user([{ role: 'approver', costCentreId: CC_A }]);
    expect(canAccessCostCentre(approver, CC_A)).toBe(true);
    expect(canAccessCostCentre(approver, CC_B)).toBe(false);
    expect(canAccessCostCentre(user([{ role: 'accounting', costCentreId: null }]), CC_B)).toBe(true);
    expect(canAccessCostCentre(user([{ role: 'auditor', costCentreId: null }]), CC_B)).toBe(true);
  });

  it('an org-wide role check is satisfied only by an org-wide grant', () => {
    // a hypothetical scoped grant of an org-wide role must NOT satisfy the check
    const scoped = user([{ role: 'auditor', costCentreId: CC_A }]);
    expect(hasRole(scoped, 'auditor')).toBe(false);
    expect(hasRoleAnywhere(scoped, 'auditor')).toBe(true);
    expect(canAccessCostCentre(scoped, CC_B)).toBe(false);
  });

  it('gives sysadmin NO financial cost-centre access (A.8.2)', () => {
    const admin = user([{ role: 'sysadmin', costCentreId: null }]);
    expect(hasRole(admin, 'sysadmin')).toBe(true);
    expect(canAccessCostCentre(admin, CC_A)).toBe(false);
  });

  it('hasAnyRole matches any of the listed roles', () => {
    const u = user([{ role: 'auditor', costCentreId: null }]);
    expect(hasAnyRole(u, ['sysadmin', 'auditor'])).toBe(true);
    expect(hasAnyRole(u, ['sysadmin', 'accounting'])).toBe(false);
  });
});
