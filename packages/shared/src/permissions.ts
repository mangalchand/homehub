import type { MemberRole } from './enums';

export type Capability =
  | 'household.manage' // rename, timezone, PIN, delete, export
  | 'devices.manage'
  | 'members.manage' // add/edit profiles, invitations
  | 'calendars.manage' // create/edit household calendars
  | 'calendars.connect' // connect own external accounts
  | 'events.write'
  | 'tasks.manage' // create/edit/delete tasks and chores
  | 'tasks.complete'
  | 'chores.approve'
  | 'rewards.manage'
  | 'rewards.redeem'
  | 'lists.write'
  | 'announcements.write'
  | 'dashboard.manage'
  | 'audit.read';

const ADULT_CORE: Capability[] = [
  'calendars.connect',
  'events.write',
  'tasks.manage',
  'tasks.complete',
  'lists.write',
  'announcements.write',
  'rewards.redeem',
];

const ROLE_CAPABILITIES: Record<MemberRole, Capability[]> = {
  OWNER: [
    'household.manage',
    'devices.manage',
    'members.manage',
    'calendars.manage',
    'chores.approve',
    'rewards.manage',
    'dashboard.manage',
    'audit.read',
    ...ADULT_CORE,
  ],
  ADULT_ADMIN: [
    'members.manage',
    'calendars.manage',
    'chores.approve',
    'rewards.manage',
    'dashboard.manage',
    ...ADULT_CORE,
  ],
  ADULT: [...ADULT_CORE],
  CHILD: ['tasks.complete', 'lists.write', 'rewards.redeem'],
  GUEST: [],
};

/** Shared wall display without PIN elevation. */
const DEVICE_CAPABILITIES: Capability[] = ['tasks.complete', 'lists.write', 'rewards.redeem'];
/** Shared wall display after a household PIN check. */
const DEVICE_ELEVATED_CAPABILITIES: Capability[] = [
  ...DEVICE_CAPABILITIES,
  'chores.approve',
  'tasks.manage',
  'events.write',
  'announcements.write',
  'dashboard.manage',
];

export type Actor =
  | { kind: 'member'; memberId: string; userId: string; role: MemberRole }
  | { kind: 'device'; deviceId: string; elevated: boolean };

export function roleCan(role: MemberRole, cap: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(cap);
}

export function can(actor: Actor, cap: Capability): boolean {
  if (actor.kind === 'device') {
    return (actor.elevated ? DEVICE_ELEVATED_CAPABILITIES : DEVICE_CAPABILITIES).includes(cap);
  }
  return roleCan(actor.role, cap);
}

export function isAdultRole(role: MemberRole): boolean {
  return role === 'OWNER' || role === 'ADULT_ADMIN' || role === 'ADULT';
}

/** Roles an actor with the given role may assign to others. Only owners can create other owners. */
export function assignableRoles(role: MemberRole): MemberRole[] {
  if (role === 'OWNER') return ['OWNER', 'ADULT_ADMIN', 'ADULT', 'CHILD', 'GUEST'];
  if (role === 'ADULT_ADMIN') return ['ADULT', 'CHILD', 'GUEST'];
  return [];
}
