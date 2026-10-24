import type { HouseholdMember } from '@prisma/client';
import { isAdultRole, type Actor, type MemberDTO } from '@familyhub/shared';

export function memberDTO(m: HouseholdMember, viewer: Actor): MemberDTO {
  const canSeeSensitive = viewer.kind === 'member' && isAdultRole(viewer.role);
  return {
    id: m.id,
    firstName: m.firstName,
    displayName: m.displayName,
    role: m.role,
    color: m.color,
    avatarUrl: m.avatarUrl,
    birthDate: m.birthDate ? m.birthDate.toISOString().slice(0, 10) : null,
    hasLogin: Boolean(m.userId),
    isActive: m.isActive,
    accessExpiresAt: m.accessExpiresAt?.toISOString() ?? null,
    ...(canSeeSensitive ? { emergencyContact: m.emergencyContact ?? null } : {}),
  };
}
